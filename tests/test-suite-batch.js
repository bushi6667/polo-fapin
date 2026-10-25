const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('suite-batch.js','utf8');
async function check(fail){
 const calls=[],storage=new Map();let state=null,current=null;
 const sandbox={localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},products:[{row:2},{row:3},{row:4}],currentProduct:{row:3},currentFileKey:()=> 'book',showToast(){},suiteTaskRunning:false,batchColorState:null,SUITE_STEP_KEYS:['111','222','333','444','666'],readSuiteAutoState:()=>state,saveSuiteAutoState:s=>state=s,selectProduct:i=>{current=sandbox.products[i];sandbox.currentProduct=current;},runSuiteFiveJob:async()=>{calls.push(current.row);state={fileKey:'book',rowNum:current.row,phase:fail?'error':'completed'};},SuiteCore:{ResultStore:()=>({list:async()=>sandbox.SUITE_STEP_KEYS.map(key=>({key,blob:{size:1}}))})}};
 sandbox.window={};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);await sandbox.startSuiteGeneration();
 assert.deepEqual(calls,fail?[3]:[3,4]);assert.equal(sandbox.suiteBatchRunning,false);
 assert.equal(sandbox.suiteBatchState.completed,!fail);if(fail)assert.equal(sandbox.suiteBatchState.index,0);
}
(async()=>{await check(false);await check(true);console.log('PASS sequential suites from current row; failure retains current row and stops next product');})().catch(e=>{console.error(e);process.exitCode=1;});
