// 执行真实后台消息处理器：恢复只读取原结果，不能重发生成或跨产品读取。
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('chrome_extension/background.js','utf8');
const start=source.indexOf('async function handleSharedAction(');
const end=source.indexOf('chrome.runtime.onMessageExternal.addListener',start);
assert(start>=0&&end>start);
const task={taskId:'existing',fileKey:'original',rowNum:2,stage:'interrupted',stageAt:{sent:1},expectCount:5,doubaoUrl:'https://www.doubao.com/chat/original',baselineUrls:['old']};
const images=Array.from({length:5},(_,i)=>'data:image/png;base64,'+Buffer.from('image'+i).toString('base64'));
let actions=[],polls=0,saved=false;
const env={console,setTimeout:fn=>{fn();return 1;},SuiteTaskStore:{
 get:async()=>task,recoverResults:async(id,identity,result)=>{
  assert.equal(id,task.taskId);assert.deepEqual(JSON.parse(JSON.stringify(identity)),{fileKey:task.fileKey,rowNum:2});
  assert.deepEqual(result,images);saved=true;return {...task,images:result};
 }
},chrome:{tabs:{query:async()=>[{id:9,url:task.doubaoUrl}],sendMessage:async(id,message)=>{
 assert.equal(id,9);actions.push(message.action);
 if(message.action==='suite-recover-bind')return {success:true};
 assert.equal(message.action,'suite-poll');assert.equal(message.binding.taskId,'existing');
 return {success:true,result:++polls===1?{ready:false,count:3}:{ready:true,images}};
}}}};
vm.createContext(env);vm.runInContext(source.slice(start,end),env);
function request(payload){return new Promise((resolve,reject)=>env.handleSharedAction({action:'suiteRecoverResults',taskId:task.taskId,...payload},resolve,{}).catch(reject));}
(async()=>{
 const denied=await request({fileKey:'other',rowNum:2});
 assert.equal(denied.ok,false);assert.match(denied.error,/身份/);assert.equal(actions.length,0,'错误产品不得触碰豆包页');
 const result=await request({fileKey:task.fileKey,rowNum:2});
 assert.equal(result.ok,true);assert.equal(result.count,5);assert(saved);
 assert.deepEqual(actions,['suite-recover-bind','suite-poll','suite-poll'],'恢复不上传、不输入、不点击发送');
 console.log('PASS real recovery message handler: identity before provider access, short polling, exact five results, no generation replay');
})().catch(e=>{console.error(e);process.exitCode=1;});
