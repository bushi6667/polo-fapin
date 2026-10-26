const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','suite-batch.js'),'utf8');
const STEPS=['111','444','222','333','666'];

// 可控沙箱：fails=第一轮失败次数，retryFails=补跑（restart）失败次数，short=少图次数，pauseOn=用户暂停所在行，seed=旧状态
function createEnv(options){
 const opt=options||{};
 const fails=Object.assign({},opt.fails||{}),retryFails=Object.assign({},opt.retryFails||{}),short=Object.assign({},opt.short||{});
 const calls=[],cancels=[],storage=new Map();
 if(opt.seed)storage.set('polo_suite_batch_v1',JSON.stringify(opt.seed));
 const current={row:2};
 // 与发品助手.html:3962-3969 同构：内存缓存优先，saveSuiteAutoState 同时写缓存与 localStorage
 const sandbox={
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  products:[{row:2},{row:3},{row:4}],currentProduct:current,currentFileKey:()=> 'book',
  showToast(){},suiteTaskRunning:false,batchColorState:null,SUITE_STEP_KEYS:STEPS,
  readSuiteAutoState:()=>{
   if(sandbox.suiteAutoState)return sandbox.suiteAutoState;
   try{const v=JSON.parse(storage.get('polo_suite_auto_v1')||'null');if(v&&v.fileKey&&Number.isInteger(v.rowNum))sandbox.suiteAutoState=v;}catch(_){}
   return sandbox.suiteAutoState;
  },
  saveSuiteAutoState:s=>{storage.set('polo_suite_auto_v1',JSON.stringify(s));sandbox.suiteAutoState=s;},
  selectProduct:i=>{sandbox.currentProduct=sandbox.products[i];},
  cancelSuiteProductTasks:async s=>{cancels.push(s.rowNum);},
  renderSuiteAutoControls(){},
  runSuiteFiveJob:async opts=>{
   const row=sandbox.currentProduct.row,restart=!!(opts&&opts.restart);
   calls.push({row,restart,autoBefore:sandbox.readSuiteAutoState()});
   if(!restart&&opt.pauseOn===row){sandbox.saveSuiteAutoState({fileKey:'book',rowNum:row,phase:'error',paused:true});await sandbox.toggleSuiteBatch();return null;}
   const budget=restart?retryFails[row]:fails[row];
   if(budget>0){if(restart)retryFails[row]--;else fails[row]--;sandbox.saveSuiteAutoState({fileKey:'book',rowNum:row,phase:'error',paused:true});return null;}
   sandbox.saveSuiteAutoState({fileKey:'book',rowNum:row,phase:'completed'});
   return null;
  },
  SuiteCore:{ResultStore:()=>({list:async(fk,row)=>{
   let keys=STEPS.slice();
   if(short[row]>0){short[row]--;keys=keys.filter(k=>k!=='666');}
   return keys.map(key=>({key,blob:{size:1}}));
  }})},
  suiteAutoState:null
 };
 sandbox.window={};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);
 return {sandbox,calls,cancels,storage,read:()=>sandbox.readSuiteAutoState()};
}

// ① 全部成功：顺序跑完，不补跑
async function allSuccess(){
 const env=createEnv();
 await env.sandbox.startSuiteGeneration();
 assert.deepEqual(env.calls.map(c=>c.row),[2,3,4]);
 assert.deepEqual(env.cancels,[]);
 assert.equal(env.sandbox.suiteBatchState.completed,true);
 assert.deepEqual([...env.sandbox.suiteBatchState.failed],[]);
 assert.equal(env.sandbox.suiteBatchState.retryRound,0);
 assert.equal(env.sandbox.suiteBatchRunning,false);
 const persisted=JSON.parse(env.storage.get('polo_suite_batch_v1'));
 assert.deepEqual(persisted.failed,[]);assert.equal(persisted.retryRound,0);
}

// ② 中间行失败 → 跳过继续下一行 → 跑完自动补跑一轮（restart 整组重来），成功行不补跑
async function skipThenRetry(){
 const env=createEnv({fails:{3:1}});
 await env.sandbox.startSuiteGeneration();
 assert.deepEqual(env.calls.map(c=>c.row),[2,3,4,3],'失败行不阻塞下一行：第一轮 2/3/4 都要跑');
 assert.deepEqual(env.calls.map(c=>c.restart),[false,false,false,true],'补跑用 restart 整组重来');
 assert.equal(env.calls.filter(c=>c.row===2).length,1,'成功行不被补跑');
 assert.equal(env.calls.filter(c=>c.row===4).length,1,'成功行不被补跑');
 assert.deepEqual(env.cancels,[3],'跳过时对失败行取消了一次在途任务');
 assert.equal(env.sandbox.suiteBatchState.index,3);
 assert.equal(env.sandbox.suiteBatchState.retryRound,1);
 assert.deepEqual([...env.sandbox.suiteBatchState.failed],[],'补跑成功后移出失败名单');
 assert.equal(env.sandbox.suiteBatchState.completed,true);
 assert.equal(env.calls[2].autoBefore,null,'失败行残留状态（含内存缓存 suiteAutoState）在下一行前已清空');
}

// ③ 只补 1 轮：每行最多两次；retryRound 持久化后不会再补第二轮
async function retryOnlyOnce(){
 const env=createEnv({fails:{2:1,3:1,4:1},retryFails:{2:1,3:1,4:1}});
 await env.sandbox.startSuiteGeneration();
 for(const row of [2,3,4])assert.equal(env.calls.filter(c=>c.row===row).length,2,`行${row}只出现两次（一轮+补跑一轮）`);
 assert.deepEqual(env.calls.filter(c=>c.restart).map(c=>c.row),[2,3,4]);
 assert.deepEqual(env.cancels,[2,3,4,2,3,4]);
 assert.equal(env.sandbox.suiteBatchState.retryRound,1);
 assert.deepEqual([...env.sandbox.suiteBatchState.failed],[2,3,4],'补跑仍失败的行保留记录');
 assert.equal(JSON.parse(env.storage.get('polo_suite_batch_v1')).retryRound,1,'retryRound 已持久化');
 const before=env.calls.length;
 await env.sandbox.runSuiteBatch();
 assert.equal(env.calls.length,before,'刷新/重入后不再补第二轮');
}

// ④ 少图 → 判定失败并跳过 → 补跑整组重来
async function shortImages(){
 const env=createEnv({short:{3:1}});
 await env.sandbox.startSuiteGeneration();
 assert.deepEqual(env.calls.map(c=>c.row),[2,3,4,3]);
 assert.deepEqual(env.calls.filter(c=>c.row===3).map(c=>c.restart),[false,true]);
 assert.deepEqual(env.cancels,[3],'少图行同样取消在途任务，避免执行锁连坐');
 assert.deepEqual([...env.sandbox.suiteBatchState.failed],[]);
 assert.equal(env.sandbox.suiteBatchState.completed,true);
}

// ⑤ 用户主动暂停 ≠ 失败：不登记失败、不跳行、不补跑
async function pauseIsNotFailure(){
 const env=createEnv({pauseOn:3});
 await env.sandbox.startSuiteGeneration();
 assert.deepEqual([...env.sandbox.suiteBatchState.failed],[],'暂停不算失败');
 assert.equal(env.sandbox.suiteBatchState.index,1,'当前行保留待续跑');
 assert.equal(env.sandbox.suiteBatchState.completed,false);
 assert.deepEqual(env.calls.map(c=>c.row),[2,3],'暂停后不再跑下一行');
 assert.deepEqual(env.cancels,[3],'暂停只取消当前行任务');
}

// ⑥ 旧 state（无 failed/retryRound）兼容成默认值
async function legacyState(){
 const env=createEnv({seed:{fileKey:'book',rows:[2,3],index:0,paused:true,completed:false}});
 assert.ok(Array.isArray(env.sandbox.suiteBatchState.failed),'旧 state 补给 failed 默认值');
 assert.equal(env.sandbox.suiteBatchState.retryRound,0);
 await env.sandbox.startSuiteGeneration();
 assert.deepEqual(env.calls.map(c=>c.row),[2,3]);
 assert.equal(env.sandbox.suiteBatchState.completed,true);
 assert.deepEqual([...env.sandbox.suiteBatchState.failed],[]);
}

(async()=>{
 await allSuccess();await skipThenRetry();await retryOnlyOnce();await shortImages();await pauseIsNotFailure();await legacyState();
 console.log('PASS suite batch: failed row skipped then retried once with restart; pause keeps row; short images restart whole row');
})().catch(e=>{console.error(e);process.exitCode=1;});
