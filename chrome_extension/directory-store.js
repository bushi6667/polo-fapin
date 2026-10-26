/* Extension-origin directory permissions: handles never cross runtime messages. */
globalThis.PoloDirectories = (() => {
 async function db() { return new Promise((resolve,reject)=>{ const r=indexedDB.open('PoloExtensionDirectories',1); r.onupgradeneeded=()=>r.result.createObjectStore('handles'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
 async function get() { const d=await db(); try { return await new Promise((resolve,reject)=>{const r=d.transaction('handles').objectStore('handles').get('ps');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); } finally {d.close();} }
 async function set(handle) { const d=await db(); try {await new Promise((resolve,reject)=>{const t=d.transaction('handles','readwrite');t.objectStore('handles').put(handle,'ps');t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});} finally {d.close();} }
 // 配置用不透明标识绑定句柄，界面只显示名称，避免把名称当绝对路径拼接。
 function isColorSelection(value) { return typeof value === 'string' && value.startsWith('polo-dir:'); }
 async function saveColorSelection(handle) {
     const token = 'polo-dir:' + crypto.randomUUID();
     const record = {handle, name:handle.name, path:token};
     await pickerRecord(token, record);
     await pickerRecord('color-img-dir', record);
     const config = await chrome.storage.local.get('polo_directory_labels');
     await chrome.storage.local.set({polo_directory_labels:{...config.polo_directory_labels,[token]:handle.name}});
     return record;
 }
 async function colorImage(token, fileFolder, rowNum, color) {
     const record = await pickerRecord(token);
     if (!record) throw new Error('颜色图目录授权不存在，请重新选择目录');
     if (await record.handle.queryPermission({mode:'read'}) !== 'granted') throw new Error('颜色图目录需要重新授权');
     if (!Number.isInteger(Number(rowNum)) || Number(rowNum)<1 || !['white','black','gray','navy'].includes(color)) throw new Error('无效颜色图参数');
     if (!fileFolder || /[\\/]/.test(fileFolder) || fileFolder==='.' || fileFolder==='..') throw new Error('无效产品文件夹');
     let dir = record.handle;
     if (dir.name !== 'Polo发品_颜色图') dir = await dir.getDirectoryHandle('Polo发品_颜色图');
     dir = await dir.getDirectoryHandle(fileFolder);
     dir = await dir.getDirectoryHandle('row'+rowNum);
     // 颜色图落盘 png / jpg 混存（压缩后转存 jpg）：逐个后缀试，命中即用，不固定某一种。
     let file = null;
     let seenEmpty = false;
     for (const ext of ['png','jpg','jpeg','webp']) {
         try { const f = await (await dir.getFileHandle('row'+rowNum+'_'+color+'.'+ext)).getFile(); if (f.size) { file = f; break; } seenEmpty = true; }
         catch (e) { if (e && e.name !== 'NotFoundError') throw e; }
     }
     if (!file) throw new Error(seenEmpty ? '颜色图为空（row'+rowNum+'_'+color+'）' : '颜色图文件不存在（row'+rowNum+'_'+color+'.png / .jpg / .jpeg / .webp）');
     const bytes = new Uint8Array(await file.arrayBuffer());
     let binary = '';
     for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
     const name = String(file.name || '');
     const type = file.type || (/\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg');
     return 'data:' + type + ';base64,' + btoa(binary);
 }
 // 路径选择器只存自己的定位句柄，不改变PS活动目录。
 async function pickerRecord(key, value) {
     const d = await db();
     try {
         return await new Promise((resolve, reject) => {
             const tx = d.transaction('handles', value === undefined ? 'readonly' : 'readwrite');
             const store = tx.objectStore('handles');
             if (value === undefined) {
                 const r = store.get('picker-' + key);
                 r.onsuccess = () => resolve(r.result);
                 r.onerror = () => reject(r.error);
             } else {
                 store.put(value, 'picker-' + key);
                 tx.oncomplete = resolve;
                 tx.onerror = tx.onabort = () => reject(tx.error);
             }
         });
     } finally { d.close(); }
 }
 // 目录授权可能随弹窗关闭而待确认，保存时缓存脚本文本，选脚本不再反复索权。
 async function collectScripts(handle) {
     const files=[];
     let bytes=0;
     async function walk(dir,prefix,depth) {
         if(depth>5)throw new Error('脚本目录层级超过5层，请缩小目录范围');
         for await(const [name,entry] of dir.entries()) {
             const path=prefix+name;
             if(entry.kind==='directory'){await walk(entry,path+'/',depth+1);continue;}
             if(!/\.js$/i.test(name))continue;
             const file=await entry.getFile();
             if(file.size>1024*1024)throw new Error(path+' 超过1MB，暂不支持导入');
             bytes+=file.size;
             if(files.length>=200||bytes>20*1024*1024)throw new Error('脚本目录过大，请选择专用JS目录');
             files.push({name,path,code:await file.text()});
         }
     }
     await walk(handle,'',0);
     return files.sort((a,b)=>a.path.localeCompare(b.path));
 }
 async function scriptDirectoryFiles() {
     let record=await pickerRecord('js-directory');
     if(!record?.handle)throw new Error('请先在扩展中保存JS脚本目录');
     const permission=await record.handle.queryPermission({mode:'read'});
     if(permission==='granted') {
         record={...record,files:await collectScripts(record.handle),revision:crypto.randomUUID(),cachedAt:Date.now()};
         await pickerRecord('js-directory',record);
     }
     if(!Array.isArray(record.files))throw new Error('请在扩展的JS脚本目录点击保存同步一次脚本');
     return {name:record.name,revision:record.revision,cached:permission!=='granted',files:record.files.map(file=>({name:file.name,path:file.path}))};
 }
 async function scriptDirectoryRead(paths,revision) {
     const record=await pickerRecord('js-directory');
     if(!record||record.revision!==revision)throw new Error('脚本目录已更新，请重新点击添加JS');
     if(!Array.isArray(paths)||!paths.length||paths.length>200)throw new Error('请选择JS脚本');
     const scripts=[];
     for(const path of new Set(paths)) {
         const file=record.files.find(item=>item.path===path);
         if(!file)throw new Error('所选脚本不在配置目录中');
         scripts.push({...file,sourceDirectory:record.name,sourceRevision:revision});
     }
     return {scripts};
 }
 // 命名目录与历史一起提交，避免保存失败留下“已填写”的半条记录。
 async function saveNamedSelection(key, handle) {
     const entries = await pickerRecord(key + '-history') || [];
     const remaining = [];
     for (const entry of entries) {
         if (!await handle.isSameEntry(entry.handle)) remaining.push(entry);
     }
     const record = {name:handle.name,handle};
     if(key==='js-directory'){record.files=await collectScripts(handle);record.revision=crypto.randomUUID();record.cachedAt=Date.now();}
     const next = [record,...remaining].slice(0,20);
     const d = await db();
     try {
         await new Promise((resolve,reject) => {
             const tx = d.transaction('handles','readwrite');
             const store = tx.objectStore('handles');
             store.put(record,'picker-' + key);
             store.put(next,'picker-' + key + '-history');
             tx.oncomplete = resolve;
             tx.onerror = tx.onabort = () => reject(tx.error);
         });
     } finally {d.close();}
 }
 // 历史记录保留真实句柄；JSON路径不能替代文件系统授权。
 async function history() {
     const d = await db();
     try {
         return await new Promise((resolve, reject) => {
             const r = d.transaction('handles').objectStore('handles').get('ps-history');
             r.onsuccess = () => resolve(Array.isArray(r.result) ? r.result : []);
             r.onerror = () => reject(r.error);
         });
     } finally { d.close(); }
 }
 async function saveSelection(handle) {
     const entries = await history();
     const remaining = [];
     for (const entry of entries) {
         // 同名文件夹可能位于不同位置，只按句柄身份去重。
         if (!await handle.isSameEntry(entry.handle)) remaining.push(entry);
     }
     const next = [{ handle, name: handle.name }, ...remaining].slice(0, 20);
     const d = await db();
     try {
         await new Promise((resolve, reject) => {
             const tx = d.transaction('handles', 'readwrite');
             const store = tx.objectStore('handles');
             store.put(handle, 'ps');
             store.put(next, 'ps-history');
             tx.oncomplete = resolve;
             tx.onerror = tx.onabort = () => reject(tx.error);
         });
     } finally { d.close(); }
 }
 async function status() {const h=await get();return {configured:!!h,name:h?.name||'',permission:h?await h.queryPermission({mode:'readwrite'}):'prompt'};}
 async function authorized(mode = 'readwrite') {const h=await get();if(!h)throw new Error('请在扩展的产品原图目录中选择文件夹并保存');if(await h.queryPermission({mode})!=='granted')throw new Error('产品原图目录已保存，请在扩展中展开该项并点击保存确认权限，无需重新选择文件夹');return h;}
 function filename(n) {if(!/^row[1-9]\d*_main\.(jpg|jpeg|png|webp)$/i.test(String(n)))throw new Error('无效的PS图片文件名');return n;}
 async function read(name) {const h=await authorized('read');const f=await(await h.getFileHandle(filename(name))).getFile();if(!f.size)throw new Error('图片为空');return {data:Array.from(new Uint8Array(await f.arrayBuffer())),type:f.type||(/png$/i.test(name)?'image/png':'image/jpeg')};}
 async function write(name,data,format) {filename(name);const bytes=new Uint8Array(data);if(!bytes.length||bytes.length>100*1024*1024)throw new Error('图片数据为空或过大');const blob=new Blob([bytes],{type:format==='png'?'image/png':format==='webp'?'image/webp':'image/jpeg'});const bitmap=await createImageBitmap(blob);try{if(!bitmap.width||!bitmap.height)throw new Error('图片无法解码');}finally{bitmap.close();}const h=await authorized();const f=await h.getFileHandle(name,{create:true});const w=await f.createWritable();try{await w.write(blob);await w.close();}catch(e){await w.abort().catch(()=>{});throw e;}const actual=new Uint8Array(await(await f.getFile()).arrayBuffer());if(actual.length!==bytes.length||actual.some((v,i)=>v!==bytes[i]))throw new Error('PS图片回读校验失败');return {saved:true,fileName:name};}
 return {get,set,status,read,write,filename,history,saveSelection,pickerRecord,isColorSelection,saveColorSelection,colorImage,saveNamedSelection,scriptDirectoryFiles,scriptDirectoryRead};
})();
