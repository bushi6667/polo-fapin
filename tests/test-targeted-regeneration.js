const assert=require('assert/strict');
const api=require('../targeted-regeneration');
assert.deepEqual(api.parse('4(0,3)'),[{row:4,selection:[0,3]}]);
assert.deepEqual(api.parse('4(0,3) 7（2） 9'),[{row:4,selection:[0,3]},{row:7,selection:[2]},{row:9,selection:null}]);
assert.deepEqual(api.parse('4(0) 4(3) 4'),[{row:4,selection:null}]);
assert.equal(api.parse('4-6(0,3)').length,3);
for(const input of ['4()','4(abc)','4(0,-1)','0','4(3)junk','4(0,,3)'])assert.throws(()=>api.parse(input));
const products=[{row:4},{row:7}],steps=[{key:'444',name:'白底图'},{key:'111',name:'卖点图'},{key:'222',name:'袖口图'}];
const jobs=api.plan(api.parse('4(0,3) 7(1)'),products,()=>steps);
assert.deepEqual(jobs[0].keys,['222']);assert(jobs[0].color);assert.deepEqual(jobs[1].keys,['444']);
assert.throws(()=>api.plan(api.parse('4(4)'),products,()=>steps));
assert.throws(()=>api.plan(api.parse('9'),products,()=>steps));
(async()=>{
const events=[];await api.run(jobs,{check(){},select:p=>events.push('row'+p.row),color:p=>events.push('color'+p.row),suite:(keys,p)=>events.push(p.row+':'+keys.join(','))});
assert.deepEqual(events,['row4','color4','4:222','row7','7:444']);
let generated=0;await assert.rejects(api.run(jobs,{check(){},select(){},color(){throw Error('paused');},suite(){generated++;}}),/paused/);assert.equal(generated,0);
// 合并派发：4(1,3,4) → 111 走原图后处理，222/333 才是生成；一次发一条，不再一步骤一条
{
    const fiveSteps=[{key:'111',name:'卖点图'},{key:'444',name:'白底图'},{key:'222',name:'袖口图'},{key:'333',name:'面料图'},{key:'666',name:'领口图'}];
    const merged=api.plan(api.parse('4(1,3,4)'),products,()=>fiveSteps);
    assert.deepEqual(merged[0].generatedKeys,['222','333']);
    assert.deepEqual(merged[0].productKeys,['111']);
    const sent=[];
    await api.run(merged,{check(){},select(){},color(){},suite:async(keys)=>{sent.push(keys.join(','));}});
    assert.deepEqual(sent,['222,333','111'],'生成类合并成一条、原图类单独一条');
}
console.log('PASS targeted syntax, category step order, merge, strict validation, sequential dispatch and stop on failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync('发品助手.html','utf8');
const start=html.indexOf('var targetedRegenerationRunning = false;');
const source=html.slice(start,html.indexOf('// 轮询兜底',start));
(async()=>{
const calls=[];let auto={jobId:'old',phase:'completed'};
// 页面已改为调用 runSuiteFiveJob（五步混合执行）并用 jobId 区分本次任务是否真的跑过。
const sandbox={TargetedRegeneration:api,products:[{row:4}],suiteTaskRunning:false,batchColorState:null,extensionInstalled:true,localStorage:{getItem(){return'';},setItem(){}},openTargetedRegenerationPanel:async()=>({input:'4(0,3)',jobs:api.plan(api.parse('4(0,3)'),[{row:4}],()=>steps)}),readSuiteAutoState:()=>auto,showToast:m=>calls.push(m),suiteFrozenSteps:()=>steps,ExcelRow:{build:x=>x},excelRowSpec:r=>({row:r}),buildRowPreviewLines:()=>['行4'],currentFileKey:()=> 'book',selectProduct(){},beginColorBatch(){sandbox.batchColorState={running:false,successCount:1};},setTimeout,runSuiteFiveJob:async({keys})=>{calls.push(keys);auto={jobId:'new',phase:'completed',fileKey:'book',rowNum:4};}};
// The actual color dispatcher starts running, then completes asynchronously.
sandbox.beginColorBatch=()=>{const state={running:true,successCount:0,failCount:0};sandbox.batchColorState=state;setTimeout(()=>{state.successCount=1;state.running=false;},1);};
vm.createContext(sandbox);vm.runInContext(source,sandbox);await sandbox.startColorChangeForRows();
assert(calls.some(x=>Array.isArray(x)&&x.join(',')==='222'));
assert(calls.some(x=>typeof x==='string'&&x.includes('全部完成')));
assert.equal(sandbox.targetedRegenerationRunning,false);
console.log('PASS production menu adapter: 4(0,3) dispatches color then step 3 and releases lock');
})().catch(e=>{console.error(e);process.exitCode=1;});
