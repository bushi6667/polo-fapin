// Sequential full-suite queue, bound to one imported workbook.
var suiteBatchRunning=false;
var suiteBatchState=null;
try{suiteBatchState=JSON.parse(localStorage.getItem('polo_suite_batch_v1')||'null');if(suiteBatchState)suiteBatchState.paused=true;}catch(_){}
function saveSuiteBatch(){localStorage.setItem('polo_suite_batch_v1',JSON.stringify(suiteBatchState));}
async function runSuiteBatch(){
    if(suiteBatchRunning||!suiteBatchState)return;
    if(suiteBatchState.fileKey!==currentFileKey()){showToast('请导入套图队列所属 Excel 后继续');return;}
    window.UnifiedTaskStarted?.();
    suiteBatchRunning=true;suiteBatchState.paused=false;saveSuiteBatch();
    try{
        while(suiteBatchState.index<suiteBatchState.rows.length&&!suiteBatchState.paused){
            if(currentFileKey()!==suiteBatchState.fileKey)throw Error('Excel 已切换，套图队列已暂停');
            const row=suiteBatchState.rows[suiteBatchState.index];
            const index=products.findIndex(p=>p.row===row);if(index<0)throw Error('找不到产品行 '+row);
            selectProduct(index);
            const previous=readSuiteAutoState();
            if(previous&&previous.phase!=='completed'){
                if(previous.fileKey!==suiteBatchState.fileKey||previous.rowNum!==row)throw Error('存在其他未完成套图任务，请先处理原任务');
                saveSuiteAutoState({...previous,paused:false});await resumeSuiteAuto();
            }else await runSuiteFiveJob({keys:SUITE_STEP_KEYS});
            const result=readSuiteAutoState();
            if(!result||result.fileKey!==suiteBatchState.fileKey||result.rowNum!==row||result.phase!=='completed'){
                suiteBatchState.paused=true;saveSuiteBatch();break;
            }
            const records=await SuiteCore.ResultStore().list(suiteBatchState.fileKey,row);
            const keys=new Set(records.filter(r=>r.blob?.size>0).map(r=>String(r.key)));
            if(!SUITE_STEP_KEYS.every(key=>keys.has(key)))throw Error('行'+row+'成品未齐全，队列已暂停');
            suiteBatchState.index++;saveSuiteBatch();
        }
        if(suiteBatchState.index>=suiteBatchState.rows.length){suiteBatchState.completed=true;suiteBatchState.paused=false;saveSuiteBatch();if(!suiteBatchState.recycled)showToast('✅ 全部产品套图生成完成');}
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
        suiteBatchState={fileKey:currentFileKey(),rows:products.slice(start).map(p=>p.row),index:0,paused:false,completed:false};saveSuiteBatch();
    }
    await runSuiteBatch();
};
