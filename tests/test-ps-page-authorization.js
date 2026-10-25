const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('发品助手.html','utf8').replace(/\r\n/g,'\n');
const start=html.indexOf('function openPhotopea(rowNum)'),end=html.indexOf('function imgToDataUrl(',start);
let permission='prompt',requests=0,reads=0,launched=null;
const pageRows=new Set();
const ctx={console:{warn(){}},Date,Set,location:{protocol:'file:'},fetch:async()=>{throw new Error('file fetch unsupported');},psDirectoryMessage:async()=>({configured:true,permission:'prompt'}),psEditDirHandle:{queryPermission:async()=>permission,requestPermission:async()=>{requests++;permission='granted';return permission;},getFileHandle:async()=>{reads++;return {getFile:async()=>({name:'row3_main.jpg'})};}},psPageSaveRows:pageRows,FileReader:class{readAsDataURL(){this.result='data:image/jpeg;base64,original';this.onload();}},openPhotopeaWithExtension:(...args)=>launched=args,showToast:message=>{throw new Error(message);}};
vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
(async()=>{ctx.openPhotopea(3);await new Promise(r=>setImmediate(r));assert.equal(requests,1);assert.equal(reads,1);assert.equal(launched[1],'row3_main.jpg');assert(pageRows.has(3));launched=null;ctx.openPhotopea(3);await new Promise(r=>setImmediate(r));assert.equal(requests,1);assert(launched);console.log('PASS 扩展待授权时恢复助手已有目录授权并读原图，再次PS编辑不重复请求已授予权限');})().catch(e=>{console.error(e);process.exitCode=1;});
