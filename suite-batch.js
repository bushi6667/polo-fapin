// Sequential full-suite queue, bound to one imported workbook.
var suiteBatchRunning=false;
var suiteBatchState=null;
try{suiteBatchState=JSON.parse(localStorage.getItem('polo_suite_batch_v1')||'null');if(suiteBatchState){suiteBatchState.paused=true;if(!Array.isArray(suiteBatchState.failed))suiteBatchState.failed=[];if(!Number.isInteger(suiteBatchState.retryRound))suiteBatchState.retryRound=0;}}catch(_){}
function saveSuiteBatch(){localStorage.setItem('polo_suite_batch_v1',JSON.stringify(suiteBatchState));}
// 失败行登记（去重）：第一轮跳过的行，跑完后统一补跑一轮。
function suiteBatchMarkFailed(row){
    if(!Array.isArray(suiteBatchState.failed))suiteBatchState.failed=[];
    if(!suiteBatchState.failed.includes(row))suiteBatchState.failed.push(row);
}
// 放弃一行：先取消该行在途任务（不取消则扩展执行锁一直被占，后面每行 suiteRun 都立即失败），
// 再清该行残留的自动状态——localStorage 与内存缓存必须一起清，否则下一行会读到旧 phase。
async function suiteBatchDropRow(row){
    await cancelSuiteProductTasks({fileKey:suiteBatchState.fileKey,rowNum:row}).catch(()=>{});
    try{localStorage.removeItem('polo_suite_auto_v1');}catch(_){}
    try{suiteAutoState=null;}catch(_){}
    if(typeof renderSuiteAutoControls==='function')renderSuiteAutoControls();
}
// 扩展执行锁竞争：上一行被取消后任务虽然立即变成终态，但执行体要等到下一条消息前才检查
// cancelled/terminal，再在 finally 里释放 __suiteExecLock（background.js:2019-2021、2107-2112）。
// 这段窗口内紧接着的 suiteRun 会被判 "already running" —— 与本行内容无关，需要等锁重试。
function suiteBatchLockBusy(){
    try{
        if(typeof document==='undefined')return false;
        const el=document.getElementById('suiteStatusText');
        return /already running|执行中/i.test(String((el&&el.textContent)||''));
    }catch(_){return false;}
}
// 跑一行并判定「完成」：runSuiteFiveJob 内部吞异常返回 null，只能靠自动状态 + 成品索引验收。
async function suiteBatchRunRow(row,restart){
    const index=products.findIndex(p=>p.row===row);if(index<0)throw Error('找不到产品行 '+row);
    selectProduct(index);
    // 首次 + 最多 3 次等锁重试（每次 2 秒）：执行锁通常在本行 cancel 后 ≤2 秒释放。
    for(let attempt=0;attempt<4;attempt++){
        if(attempt){
            await suiteBatchDropRow(row);          // 清掉上一次失败留下的任务与残留状态
            await new Promise(r=>setTimeout(r,2000));
        }
        if(await suiteBatchRunRowOnce(row,restart))return true;
        // 只有「执行锁未释放」才重试；用户暂停或内容类失败立刻交给调用方记失败跳过。
        if(suiteBatchState.paused||!suiteBatchLockBusy())return false;
    }
    return false;
}
async function suiteBatchRunRowOnce(row,restart){
    const previous=readSuiteAutoState();
    // 只有同一行的未完成状态才续跑；别的行残留的状态不能卡住当前行。
    if(!restart&&previous&&previous.phase!=='completed'&&previous.fileKey===suiteBatchState.fileKey&&previous.rowNum===row){
        saveSuiteAutoState({...previous,paused:false});await resumeSuiteAuto();
    }else await runSuiteFiveJob(restart?{keys:SUITE_STEP_KEYS,restart:true}:{keys:SUITE_STEP_KEYS});
    const result=readSuiteAutoState();
    if(!result||result.fileKey!==suiteBatchState.fileKey||result.rowNum!==row||result.phase!=='completed')return false;
    const records=await SuiteCore.ResultStore().list(suiteBatchState.fileKey,row);
    const keys=new Set(records.filter(r=>r.blob?.size>0).map(r=>String(r.key)));
    return SUITE_STEP_KEYS.every(key=>keys.has(key));
}
async function runSuiteBatch(){
    if(suiteBatchRunning||!suiteBatchState)return;
    if(suiteBatchState.fileKey!==currentFileKey()){showToast('请导入套图队列所属 Excel 后继续');return;}
    window.UnifiedTaskStarted?.();
    suiteBatchRunning=true;suiteBatchState.paused=false;saveSuiteBatch();
    try{
        while(suiteBatchState.index<suiteBatchState.rows.length&&!suiteBatchState.paused){
            if(currentFileKey()!==suiteBatchState.fileKey)throw Error('Excel 已切换，套图队列已暂停');
            const row=suiteBatchState.rows[suiteBatchState.index];
            const complete=await suiteBatchRunRow(row,false);
            if(complete){suiteBatchState.index++;saveSuiteBatch();continue;}
            // 用户主动暂停不算失败：当前行保留待续跑，不能登记失败也不能跳过。
            if(suiteBatchState.paused)break;
            suiteBatchMarkFailed(row);
            await suiteBatchDropRow(row);
            suiteBatchState.index++;saveSuiteBatch();
        }
        // 第一轮跑完，对失败行自动补跑一轮（restart=取消该行任务 + 清冻结 + 整组重来），只补一轮。
        if(!suiteBatchState.retryRound&&!suiteBatchState.paused&&Array.isArray(suiteBatchState.failed)&&suiteBatchState.failed.length){
            suiteBatchState.retryRound=1;saveSuiteBatch();
            const retryRows=suiteBatchState.failed.slice();
            for(const row of retryRows){
                if(suiteBatchState.paused)break;
                if(currentFileKey()!==suiteBatchState.fileKey){showToast('⚠️ Excel 已切换，套图补跑已停止');break;}
                let complete=false;
                try{complete=await suiteBatchRunRow(row,true);}
                catch(e){showToast('⚠️ 行'+row+' 补跑失败：'+e.message);}
                if(complete)suiteBatchState.failed=suiteBatchState.failed.filter(r=>r!==row);
                else await suiteBatchDropRow(row);   // 仍失败：保留在 failed，不再补跑
                saveSuiteBatch();
            }
        }
        if(suiteBatchState.index>=suiteBatchState.rows.length){
            suiteBatchState.completed=true;suiteBatchState.paused=false;saveSuiteBatch();
            const failed=Array.isArray(suiteBatchState.failed)?suiteBatchState.failed:[];
            if(!suiteBatchState.recycled){
                if(failed.length)showToast('⚠️ 套图队列已跑完：'+failed.length+' 行失败（已补跑 1 轮）｜行 '+failed.join('/'));
                else showToast('✅ 全部产品套图生成完成');
            }
        }
    }catch(e){suiteBatchState.paused=true;saveSuiteBatch();showToast('⚠️ '+e.message);}
    finally{suiteBatchRunning=false;}
}
async function toggleSuiteBatch(){
    if(suiteBatchRunning){
        suiteBatchState.paused=true;saveSuiteBatch();
        const state=readSuiteAutoState();
        if(state&&state.phase!=='completed'){saveSuiteAutoState({...state,paused:true});await cancelSuiteProductTasks(state).catch(e=>showToast(e.message));}
        return;
    }
    if(typeof ensurePsDirPermission==='function')await ensurePsDirPermission();
    await runSuiteBatch();
}
startSuiteGeneration=async function(){
    if(suiteBatchRunning)return showToast('套图队列正在运行');
    if(typeof targetedRegenerationRunning!=='undefined'&&targetedRegenerationRunning||suiteTaskRunning||batchColorState?.running)return showToast('请先暂停当前任务');
    if(!products.length||!currentProduct)return showToast('请先选择产品');
    // 手势内恢复产品原图目录授权；后续连续行复用同一授权
    const perm=typeof ensurePsDirPermission==='function'?await ensurePsDirPermission():{ok:true};
    if(!perm.ok&&perm.reason)console.warn('产品原图目录授权未恢复：'+perm.reason);
    if(!suiteBatchState||suiteBatchState.completed){
        const previous=readSuiteAutoState();
        const start=previous&&previous.phase!=='completed'&&previous.fileKey===currentFileKey()?products.findIndex(p=>p.row===previous.rowNum):products.findIndex(p=>p.row===currentProduct.row);
        if(start<0)return showToast('找不到任务所属产品');
        suiteBatchState={fileKey:currentFileKey(),rows:products.slice(start).map(p=>p.row),index:0,paused:false,completed:false,failed:[],retryRound:0};saveSuiteBatch();
    }
    await runSuiteBatch();
};
