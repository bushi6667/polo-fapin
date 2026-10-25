const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let storage={};const env={console,chrome:{storage:{local:{get:(key,cb)=>cb({[key]:storage[key]}),set:(value,cb)=>{Object.assign(storage,structuredClone(value));cb();}}}}};
env.globalThis=env;vm.createContext(env);vm.runInContext(fs.readFileSync('chrome_extension/suite/suite-task.js','utf8'),env);
(async()=>{
 const S=env.SuiteTaskStore,identity={fileKey:'A',rowNum:2};
 const t=await S.create({...identity,mode:'quick-five',expectCount:5,targetKeys:['111','444','222','333','666']});
 const images=Array.from({length:5},(_,i)=>'data:image/png;base64,'+Buffer.from('image'+i).toString('base64'));
 await assert.rejects(()=>S.recoverResults(t.taskId,identity,images),/已发送/);
 await S.advance(t.taskId,'sent');await S.interrupt(t.taskId,'worker stopped');
 assert.equal((await S.acceptReport({taskId:t.taskId,...identity,stage:'acquired'})).accepted,false,'late unsolicited completion is still rejected');
 await assert.rejects(()=>S.recoverResults(t.taskId,{fileKey:'B',rowNum:2},images),/身份/);
 await assert.rejects(()=>S.recoverResults(t.taskId,identity,images.slice(1)),/数量/);
 const restored=await S.recoverResults(t.taskId,identity,images);assert.equal(restored.stage,'acquired');assert.equal(restored.images.length,5);
 assert.equal((await S.recoverResults(t.taskId,identity,images)).stage,'acquired','idempotent explicit recovery');
 await assert.rejects(()=>S.recoverResults(t.taskId,identity,images.map((u,i)=>i?u:u+'changed')),/覆盖/);
 await S.cancel(t.taskId);await assert.rejects(()=>S.recoverResults(t.taskId,identity,images),/不能恢复/);
 console.log('PASS explicit recovery requires sent evidence, original identity, exactly five unique results; cancellation and unsolicited late-result guards remain');
})().catch(e=>{console.error(e);process.exitCode=1;});
