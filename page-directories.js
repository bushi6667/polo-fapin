/* 页面持有唯一的目录授权；扩展通过既有长连接请求读写，不需要本地服务。 */
(() => {
    'use strict';
    const handles = {}, records = {}, scriptSnapshots = new Map();
    const keys = ['colorImgDir','imageDir','scriptDir'];
    let migrationConflict=false;
    function db() { return new Promise((resolve,reject)=>{
        const req=indexedDB.open('PoloPageDirectories',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('handles');
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    }); }
    async function store(key,value) {const d=await db();try{return await new Promise((resolve,reject)=>{
        const tx=d.transaction('handles',value?'readwrite':'readonly'),s=tx.objectStore('handles');
        if(value){s.put(value,key);tx.oncomplete=resolve;}else{const r=s.get(key);r.onsuccess=()=>resolve(r.result);}
        tx.onerror=()=>reject(tx.error);
    });}finally{d.close();}}
    const ready=Promise.all(keys.map(async key=>{const r=await store(key);if(r?.handle){records[key]=r;handles[key]=r.handle;}})).then(async()=>{
        const legacy=await store('suiteDir');
        if(legacy?.handle&&!records.colorImgDir?.unified){
            const same=handles.colorImgDir&&(handles.colorImgDir===legacy.handle||await handles.colorImgDir.isSameEntry(legacy.handle));
            migrationConflict=!same;
        }
    });
    ready.catch(e=>console.warn('读取页面目录失败',e));
    async function choose(key) {
        if(!keys.includes(key))throw Error('未知目录');
        if(typeof suiteTaskRunning!=='undefined'&&suiteTaskRunning||typeof batchColorState!=='undefined'&&batchColorState?.running)throw Error('请先暂停生成任务，再更换目录');
        // 文件选择器在点击手势内直接调用。
        const handle=await window.showDirectoryPicker({id:'polo-'+key,mode:key==='scriptDir'?'read':'readwrite',...(handles[key]?{startIn:handles[key]}:{})});
        const record={handle,name:handle.name,...(key==='colorImgDir'?{unified:true}:{})};await store(key,record);records[key]=record;handles[key]=handle;
        if(key==='colorImgDir')migrationConflict=false;
        if(key==='imageDir'&&typeof psEditDirHandle!=='undefined'){
            psEditDirHandle=handle;
            const d=await openIDB();try{await setIDBValue(d,PS_DIR_IDB_KEY,handle);}finally{d.close();}
        }
        return record;
    }
    // 只查询、不申请（申请必须由用户手势触发）：用于启动时判断要不要提示"重新授权"
    async function queryPermissions() {
        await ready;
        const out = {};
        for (const [key, h] of Object.entries(handles)) {
            try { out[key] = await h.queryPermission({ mode: key === 'scriptDir' ? 'read' : 'readwrite' }); }
            catch (_) { out[key] = 'prompt'; }
        }
        return out;
    }

    function permissions() {
        // 不先 queryPermission；所有申请都从当前点击同步发起。
        return Promise.all(Object.entries(handles).map(([key,h])=>h.requestPermission({mode:key==='scriptDir'?'read':'readwrite'})));
    }
    async function root(key,write=false) {
        await ready;if(key==='suiteDir')key='colorImgDir';
        if(key==='colorImgDir'&&migrationConflict)throw Error('旧图片目录与套图输出目录不同，请在路径配置重新选择统一的产品图片目录；旧文件保留原位');
        const h=handles[key];
        if(!h)throw Error('请在页面「路径配置」选择'+({imageDir:'产品原图目录',scriptDir:'JS脚本目录',colorImgDir:'产品图片目录'}[key]));
        if(await h.queryPermission({mode:write?'readwrite':'read'})!=='granted')throw Error('目录需要授权，请在页面「路径配置」点击确认授权');
        return h;
    }
    function segments(path){const p=String(path||'');if(!p||p.length>500||p.includes('\\')||p.split('/').some(s=>!s||s==='.'||s==='..'||/[\x00-\x1f:*?"<>|]/.test(s)))throw Error('无效的目录内相对路径');return p.split('/');}
    async function file(key,path,create=false){const parts=segments(path);let dir=await root(key,create);for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create});return dir.getFileHandle(parts.at(-1),{create});}
    function dataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});}
    async function readImage(key,path){
        let f;
        try{ f=await(await file(key,path)).getFile(); }
        catch(e){ if(e&&e.name==='NotFoundError')throw Error('图片不存在：'+path); throw e; }
        if(!f.size)throw Error('图片文件为空：'+path);
        const b=await createImageBitmap(f);const width=b.width,height=b.height;b.close();
        return {ok:true,fromDisk:true,dataUrl:await dataUrl(f),type:f.type||'image/png',width,height,bytes:f.size};
    }
    // 同一张图可能是 .jpg（压缩后）或 .png（原始）：按顺序试，返回实际命中的扩展名。
    async function readFirst(key,base){
        let last=null;
        for(const ext of ['jpg','png','jpeg','webp']){
            try{ const got=await readImage(key,base+'.'+ext); return Object.assign(got,{ext,filename:segments(base+'.'+ext).at(-1)}); }
            catch(e){ last=e; }
        }
        throw last || Error('图片不存在：'+base);
    }
    // 磁盘上 png / jpg 混存：调用方给的名字可能带错后缀（如 row3_main.jpg 实际是 .png）。
    // 先按原名读（原名的优先级最高）；缺失或空文件时才换同名其它图片后缀，
    // 并把实际命中的文件名带回给调用方。全部失败时抛最初那条错误，保留真实原因（空/缺失）。
    const IMAGE_FILE_RE=/\.(png|jpe?g|webp)$/i;
    async function readImageAny(key,name){
        const raw=String(name||'');
        let first=null;
        try{
            const got=await readImage(key,raw);
            return Object.assign(got,{ext:(raw.match(IMAGE_FILE_RE)||[,''])[1].toLowerCase(),filename:segments(raw).at(-1)});
        }catch(e){
            first=e;
        }
        // 授权/权限/解码/非法路径等错误必须原样上抛，不能当成「换后缀」的理由
        if(!/不存在|为空/.test(String(first&&first.message))||!IMAGE_FILE_RE.test(raw))throw first;
        try{ return await readFirst(key,raw.replace(IMAGE_FILE_RE,'')); }
        catch(_){ throw first; }
    }
    async function hash(blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
    async function writeImage(key,path,blob){
        if(!blob.size||blob.size>100*1024*1024)throw Error('图片大小无效');
        const bitmap=await createImageBitmap(blob),width=bitmap.width,height=bitmap.height;bitmap.close();
        const h=await file(key,path,true),w=await h.createWritable();
        try{await w.write(blob);await w.close();}catch(e){await w.abort().catch(()=>{});throw e;}
        const actual=await h.getFile(),contentHash=await hash(blob);
        if(actual.size!==blob.size||await hash(actual)!==contentHash)throw Error('图片回读校验失败');
        return {saved:true,filename:segments(path).at(-1),bytes:actual.size,width,height,contentHash,path};
    }
    async function scripts(){
        const dir=await root('scriptDir'),files=[];let bytes=0;
        async function walk(h,prefix,depth){if(depth>8)throw Error('脚本目录层级过深');for await(const [name,item]of h.entries()){
            if(name.startsWith('.'))continue;const path=prefix+name;
            if(item.kind==='directory')await walk(item,path+'/',depth+1);
            else if(/\.js$/i.test(name)){const f=await item.getFile();bytes+=f.size;if(files.length>=200||bytes>20*1024*1024)throw Error('请使用专用JS脚本目录');files.push({name,path,code:await f.text()});}
        }}
        await walk(dir,'',0);const revision=crypto.randomUUID();scriptSnapshots.clear();scriptSnapshots.set(revision,files);
        return {ok:true,name:dir.name,revision,cached:false,files:files.map(({name,path})=>({name,path}))};
    }
    async function dispatch(r){
        await ready;
        switch(r.action){
        case 'listScriptDirectory':return scripts();
        case 'readScriptDirectory':{const files=scriptSnapshots.get(r.revision);if(!files)throw Error('脚本目录已更新，请重新添加JS');if(!Array.isArray(r.paths)||r.paths.length>200)throw Error('脚本选择无效');return {ok:true,scripts:r.paths.map(path=>{const f=files.find(x=>x.path===path);if(!f)throw Error('所选脚本不在目录中');return {...f,sourceDirectory:records.scriptDir.name,sourceRevision:r.revision};})};}
        case 'psDirectoryStatus':{const h=handles.imageDir;return {ok:true,configured:!!h,name:h?.name||'',permission:h?await h.queryPermission({mode:'readwrite'}):'prompt'};}
        case 'readPsImage':return readImageAny('imageDir',r.fileName);
        case 'writePsImage':return {ok:true,...await writeImage('imageDir',r.fileName,new Blob([new Uint8Array(r.data)],{type:r.format==='png'?'image/png':'image/jpeg'}))};
        case 'pageReadColor':return readFirst('colorImgDir',r.fileFolder+'/row'+r.rowNum+'/row'+r.rowNum+'_'+r.color);
        // 套图成品按磁盘现读：<文件名>/rowN/<编号>.png（一次拿多张，缺哪张就少哪张，不抛错中断）
        // 一次扫完整个产品目录，返回每行有哪些成品图（只看文件名，不读内容 → 快）。
        // 角标要按磁盘判定，逐行读 5 张会有 500 次文件读取，太慢。
        case 'pageScanSuiteRows':{
            const out={},colorOut={};
            const rootDir=await root('colorImgDir');
            const baseDir=r.fileFolder?await rootDir.getDirectoryHandle(r.fileFolder,{create:false}):rootDir;
            for await (const entry of baseDir.values()){
                if(entry.kind!=='directory')continue;
                const m=/^row(\d+)$/.exec(entry.name);
                if(!m)continue;
                const keys=[], colors=[];
                const rowNum=m[1];
                try{
                    for await (const f of entry.values()){
                        if(f.kind!=='file')continue;
                        const km=/^(111|222|333|444|666)\.(png|jpg|jpeg|webp)$/i.exec(f.name);
                        if(km){keys.push(km[1]);continue;}
                        // 颜色图命名：rowN_<颜色>.png
                        const cm=new RegExp('^row'+rowNum+'_(.+)\.(png|jpg|jpeg|webp)$','i').exec(f.name);
                        if(cm)colors.push(cm[1]);
                    }
                }catch(_){}
                if(keys.length)out[rowNum]=[...new Set(keys)];
                if(colors.length)colorOut[rowNum]=[...new Set(colors)];
            }
            return {ok:true,rows:out,colors:colorOut};
        }
        case 'pageReadSuite':{
            const base=(r.fileFolder?r.fileFolder+'/':'')+'row'+r.rowNum+'/';
            const files=[];
            for(const key of (r.keys||[])){
                try{const got=await readFirst('suiteDir',base+key);files.push({key,dataUrl:got.dataUrl,type:got.type,width:got.width,height:got.height,bytes:got.bytes,filename:got.filename,ext:got.ext});}
                catch(e){files.push({key,error:e.message,missing:e.name==='NotFoundError'||/不存在/.test(e.message)});}
            }
            return {ok:files.some(f=>f.dataUrl),files};
        }
        case 'pageWriteColor':{const blob=await(await fetch(r.dataUrl)).blob();return {ok:true,...await writeImage('colorImgDir',r.fileFolder+'/row'+r.rowNum+'/'+r.filename,blob)};}
        // 压缩用：把任意成品图写回产品图片目录（不限 111/222 等编号）
        case 'pageWriteImage':{
            const fn=String(r.filename||'');
            if(!fn||fn.includes('/')||fn.includes('\\')||fn==='.'||fn==='..'||!/[.](jpg|jpeg|png|webp)$/i.test(fn))throw Error('无效的图片文件名');
            const blob=await(await fetch(r.dataUrl)).blob();
            return {ok:true,...await writeImage('colorImgDir',r.fileFolder+'/row'+r.rowNum+'/'+fn,blob)};
        }
        // 压缩后旧格式文件必须删除，否则读取会优先命中旧图
        case 'pageDeleteFile':{
            const fn=String(r.filename||'');
            // 与写路径同等严格：只允许单段文件名，显式拒绝两种分隔符与 . / ..
            if(!fn||fn.includes('/')||fn.includes('\\')||fn==='.'||fn==='..'||!/[.](jpg|jpeg|png|webp)$/i.test(fn))throw Error('无效的图片文件名');
            const parts=segments(r.fileFolder+'/row'+r.rowNum);
            let dir=await root('colorImgDir',true);
            for(const part of parts)dir=await dir.getDirectoryHandle(part,{create:false});
            try{ await dir.removeEntry(fn); return {ok:true,removed:true}; }
            catch(e){ if(e&&e.name==='NotFoundError')return {ok:true,removed:false}; throw e; }
        }
        case 'suiteOutputStatus':{if(migrationConflict)throw Error('旧目录不同，请在页面重新选择统一的产品图片目录；旧文件保留原位');const h=handles.colorImgDir;return {ok:true,configured:!!h,name:h?.name||'',permission:h?await h.queryPermission({mode:'readwrite'}):'prompt',canFallback:false,mode:'page-filesystem'};}
        case 'suiteWriteOutput':{
            const results=[];for(const f of r.files||[]){if(!/^(111|222|333|444|666)\.(png|jpg|jpeg|webp)$/i.test(f.filename))throw Error('无效套图文件名');const blob=await(await fetch(f.dataUrl)).blob();results.push({key:f.key,...await writeImage('suiteDir',r.subdir+'/'+f.filename,blob)});}
            return {ok:results.length>0,results,mode:'page-filesystem',dirName:handles.colorImgDir?.name};
        }
        case 'suiteVerifyOutput':{
            const items=[];for(const r0 of r.records||[]){let status='verified',detail='';try{const f=await(await file('suiteDir',r.subdir+'/'+r0.filename)).getFile();if(!f.size)status='corrupt';else if(r0.bytes&&f.size!==r0.bytes||r0.contentHash&&await hash(f)!==r0.contentHash)status='replaced';else{const b=await createImageBitmap(f);b.close();}}catch(e){status=e.name==='NotFoundError'?'missing':/授权|权限/.test(e.message)?'no-permission':'error';detail=e.message;}items.push({key:String(r0.key),filename:r0.filename,status,detail});}
            return {ok:items.length>0&&items.every(x=>x.status==='verified'),items,unverified:items.filter(x=>x.status!=='verified').map(x=>x.key)};
        }
        default:throw Error('不支持的页面目录操作');
        }
    }
    window.PageDirectories={ready,choose,permissions,queryPermissions,dispatch,readImage,handles,records};
    ready.then(()=>{if(handles.imageDir&&typeof psEditDirHandle!=='undefined')psEditDirHandle=handles.imageDir;}).catch(()=>{});
})();
