const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const {webcrypto}=require('node:crypto');
const saved=new Map();
function directory(name){const children=new Map();return {name,kind:'directory',permission:'granted',async queryPermission(){return this.permission;},async requestPermission(){return this.permission;},async getDirectoryHandle(n,o){if(!children.has(n)){if(!o?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});children.set(n,directory(n));}return children.get(n);},async getFileHandle(n,o){if(!children.has(n)){if(!o?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});let blob=new Blob([]);children.set(n,{name:n,kind:'file',async getFile(){return blob;},async createWritable(){return {async write(b){blob=b;},async close(){},async abort(){}};}});}return children.get(n);},async *entries(){yield* children.entries();}};}
const selected=directory('selected'),other=directory('other');let picked=selected;
class Reader{readAsDataURL(b){b.arrayBuffer().then(a=>{this.result='data:'+b.type+';base64,'+Buffer.from(a).toString('base64');this.onload();});}}
const env={window:{showDirectoryPicker:async()=>picked},console,Blob,Uint8Array,Map,Promise,Array,String,Error,crypto:webcrypto,FileReader:Reader,fetch,createImageBitmap:async()=>({width:256,height:256,close(){}}),indexedDB:{open(){const req={};queueMicrotask(()=>{req.result={close(){},transaction(){const tx={objectStore(){return {get(k){const r={};queueMicrotask(()=>{r.result=saved.get(k);r.onsuccess();});return r;},put(v,k){saved.set(k,v);queueMicrotask(()=>tx.oncomplete());}};}};return tx;}};req.onsuccess();});return req;}}};
vm.createContext(env);vm.runInContext(fs.readFileSync(path.join(__dirname,'../page-directories.js'),'utf8'),env);
(async()=>{
 const api=env.window.PageDirectories;await api.ready;
 assert.equal((await api.dispatch({action:'suiteOutputStatus'})).configured,false);
 await api.choose('colorImgDir');assert.equal(saved.get('colorImgDir').handle,selected);
 const dataUrl='data:image/png;base64,'+Buffer.from('test image').toString('base64');
 const written=await api.dispatch({action:'suiteWriteOutput',subdir:'book/row3',files:[{key:'444',filename:'444.png',dataUrl}]});
 assert(written.ok);assert.equal(written.results[0].bytes,10);
 const verified=await api.dispatch({action:'suiteVerifyOutput',subdir:'book/row3',records:[{key:'444',filename:'444.png',bytes:10,contentHash:written.results[0].contentHash}]});assert(verified.ok);
 await api.dispatch({action:'pageWriteColor',fileFolder:'book',rowNum:3,filename:'row3_white.png',dataUrl});
 assert.equal((await api.dispatch({action:'pageReadColor',fileFolder:'book',rowNum:3,color:'white'})).dataUrl,dataUrl);
 picked=other;await api.choose('colorImgDir');assert.equal((await api.dispatch({action:'suiteOutputStatus'})).name,'other');
 const missing=await api.dispatch({action:'suiteVerifyOutput',subdir:'book/row3',records:[{key:'444',filename:'444.png'}]});assert.equal(missing.items[0].status,'missing');
 other.permission='denied';await assert.rejects(()=>api.dispatch({action:'suiteWriteOutput',subdir:'book/row3',files:[{key:'444',filename:'444.png',dataUrl}]}),/授权/);
 await assert.rejects(()=>api.readImage('colorImgDir','../secret.png'),/无效/);
 picked=selected;await api.choose('colorImgDir');await api.choose('scriptDir');
 const script=await selected.getFileHandle('test.js',{create:true}),writer=await script.createWritable();await writer.write(new Blob(['function process() {}']));await writer.close();
 const listing=await api.dispatch({action:'listScriptDirectory'});assert.equal(listing.files[0].path,'test.js');
 const scripts=await api.dispatch({action:'readScriptDirectory',paths:['test.js'],revision:listing.revision});assert.equal(scripts.scripts[0].code,'function process() {}');
 await assert.rejects(()=>api.dispatch({action:'readScriptDirectory',paths:['secret.js'],revision:listing.revision}),/不在目录/);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../page-directories.js'),'utf8'),env);
 await env.window.PageDirectories.ready;
 assert.equal(env.window.PageDirectories.handles.colorImgDir,selected,'reload restores directory handle');
 assert.equal((await env.window.PageDirectories.dispatch({action:'pageReadColor',fileFolder:'book',rowNum:3,color:'white'})).dataUrl,dataUrl);
 console.log('PASS persistent unified image directory, shared suite/color write and verification, missing/permission/traversal failures');
})().catch(e=>{console.error(e);process.exitCode=1;});
