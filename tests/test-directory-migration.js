const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let handle=null,permission='granted',writeDenied=false,disk=new Map(),truncated=false;
const directory={name:'extracted_images',queryPermission:async options=>writeDenied&&options.mode==='readwrite'?'denied':permission,getFileHandle:async(name,opts)=>{if(!disk.has(name)&&!opts?.create)throw Object.assign(new Error('missing'),{name:'NotFoundError'});return {createWritable:async()=>({write:async(blob)=>{const b=new Uint8Array(await blob.arrayBuffer());disk.set(name,truncated?b.slice(0,1):b);},close:async()=>{},abort:async()=>{}}),getFile:async()=>{const b=disk.get(name);return {size:b.length,type:'image/png',arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};}};}};
const indexedDB={open(){const req={};queueMicrotask(()=>{req.result={close(){},transaction(store,mode){const t={objectStore(){return {get(){const r={};queueMicrotask(()=>{r.result=handle;r.onsuccess();});return r;},put(value){handle=value;queueMicrotask(()=>t.oncomplete());}};}};return t;}};req.onsuccess();});return req;}};
const ctx={indexedDB,Blob,Uint8Array,createImageBitmap:async()=>({width:10,height:10,close(){}})};vm.createContext(ctx);vm.runInContext(fs.readFileSync('chrome_extension/directory-store.js','utf8'),ctx);const api=ctx.PoloDirectories;
(async()=>{
 assert.equal((await api.status()).configured,false);
 await api.set(directory);assert.equal((await api.status()).permission,'granted');
 await api.write('row2_main.png',[137,80,78,71], 'png');assert.deepEqual(Array.from((await api.read('row2_main.png')).data),[137,80,78,71]);
 await assert.rejects(()=>api.write('../outside.png',[1],'png'),/无效/);
 await assert.rejects(()=>api.write('row2_main.png',[],'png'),/为空/);
 permission='denied';await assert.rejects(()=>api.read('row2_main.png'),/确认权限/);permission='granted';
 writeDenied=true;await api.read('row2_main.png');await assert.rejects(()=>api.write('row2_main.png',[1,2,3],'png'),/确认权限/);writeDenied=false;
 truncated=true;await assert.rejects(()=>api.write('row2_main.png',[1,2,3],'png'),/回读/);
 const html=fs.readFileSync('发品助手.html','utf8');assert(!html.includes('id="colorImgDirInput"'));assert(!html.includes('id="psDirPanel"'));assert(!html.includes('id="syncToExtensionBtn"'));assert(html.includes('function openPhotopea('));assert(html.includes("action:'writePsImage'"));
 const bg=fs.readFileSync('chrome_extension/background.js','utf8');assert(!bg.includes('window.showDirectoryPicker'));assert(bg.includes('savedByExtension = true'));assert(bg.includes("'writePsImage'"));
 console.log('目录迁移测试通过：授权、实际写入回读、非法文件名、空文件、权限失效、截断文件、页面入口与消息路由');
})().catch(e=>{console.error(e);process.exitCode=1;});
