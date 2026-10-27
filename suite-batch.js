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
// 豆包账号自动切号：必须带 EXTENSION_ID、每次判 lastError，且不加超时
// （扫描一轮账号可达 2 分钟，短超时会把正在跑的扫描掐死）。
// 不试生图：切号成功后直接重跑当前行真实任务，出图=可用，弹额度/连续不出图=换下一个号。
var suiteBatchAutoSwitchRunning=false;
var suiteBatchTriedAccounts=[];   // 本轮已试过的账号名（批次结束/换批时清零）
var suiteBatchAttempts=0;         // 本轮换号次数（硬上限，防死循环）
var SUITE_BATCH_SWITCH_LIMIT=12;  // 一轮最多换 12 次号
function suiteBatchAutoSwitchMessage(exclude){
    return new Promise(function(resolve,reject){
        try{
            if(typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.sendMessage){reject(Error('扩展未连接'));return;}
            var id=typeof EXTENSION_ID==='undefined'?'':EXTENSION_ID;
            chrome.runtime.sendMessage(id,{action:'doubaoAutoSwitch',exclude:Array.isArray(exclude)?exclude.slice():[]},function(response){
                var err=chrome.runtime.lastError;
                if(err){reject(Error(err.message||'扩展通道异常'));return;}
                if(!response){reject(Error('扩展没有响应'));return;}
                resolve(response);
            });
        }catch(e){reject(e);}
    });
}
// 生成结果记账（套图侧自己上报，因为套图内容脚本不报）：
//   ok=true  → 该账号能出图，连续失败计数归零
//   ok=false → 后台连续 3 次判它「不支持生图」，返回 disabled:true → 换号重跑本行
// 通道不可用/异常一律 reject/返回 null，调用方按「照旧记失败」处理，不影响队列。
function suiteBatchGenResult(row,ok,reason){
    return new Promise(function(resolve,reject){
        try{
            if(typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.sendMessage){reject(Error('扩展未连接'));return;}
            var id=typeof EXTENSION_ID==='undefined'?'':EXTENSION_ID;
            var payload={action:'doubaoGenResult',ok:!!ok,row:row};
            if(!ok)payload.reason=String(reason||'').slice(0,120);
            chrome.runtime.sendMessage(id,payload,function(response){
                var err=chrome.runtime.lastError;
                if(err){reject(Error(err.message||'扩展通道异常'));return;}
                if(!response){reject(Error('扩展没有响应'));return;}
                resolve(response);
            });
        }catch(e){reject(e);}
    });
}
// 成功出图：把该账号的连续失败计数归零（fire-and-forget，失败只打 warn）
function suiteBatchGenOk(row){
    if(typeof chrome==='undefined'||!chrome.runtime||!chrome.runtime.sendMessage)return;
    suiteBatchGenResult(row,true,'').then(null,function(e){
        if(typeof console!=='undefined')console.warn('套图生成成功记账失败（不影响队列）：'+((e&&e.message)||e));
    });
}
// 生成不出图（非额度）：上报后问后台该账号是否已被判不可用。
// 返回 true  = 已接管：已判「不支持生图」→ 触发换号（成功后原地重跑本行、不记失败），调用方不要再记失败。
// 返回 false = 照旧记失败跳过（偶发失败、通道不可用、后台说还能用）。
async function suiteBatchGenFailGate(row){
    if(!suiteBatchState)return false;
    var state=readSuiteAutoState();
    if(!state||state.fileKey!==suiteBatchState.fileKey||state.rowNum!==row||state.phase!=='error')return false;
    var text=String(state.error||'');
    // 额度有独立机制（suiteBatchQuotaPause 已经处理过这里才会走到），别把额度记成不会生图
    if(/额度\s*[,，]?\s*已\s*用完/.test(text))return false;
    var res=null;
    try{res=await suiteBatchGenResult(row,false,text);}
    catch(e){
        if(typeof console!=='undefined')console.warn('套图生成失败记账失败（不影响队列）：'+((e&&e.message)||e));
        return false;
    }
    if(!res||res.disabled!==true)return false;
    if(!suiteBatchState||suiteBatchState.rows[suiteBatchState.index]!==row)return false;
    var name=String(res.name||'').trim();
    var streak=Number(res.streak)||3;
    var line='已连续 '+streak+' 次生成失败，判定该账号不支持生图'+(name?'（'+name+'）':'')+'，正在换号…';
    if(typeof console!=='undefined')console.warn('🔀 row'+row+' '+line);
    showToast('⚠️ '+line);
    suiteBatchState.paused=true;
    suiteBatchState.pausedReason='已连续 '+streak+' 次生成失败，判定该账号不支持生图';
    saveSuiteBatch();
    suiteBatchTryAutoSwitch(row,'genfail');
    return true;
}
// 换号成功：清掉该行 error 残留（内存缓存 + localStorage 一起清，否则下一行读到旧 phase），
// index 不前进、paused 复位，然后原地重启该行（等价于重跑）。
// 重跑后又弹额度/又不出图 → 本函数会被再次调用（防重入 flag 在请求结束即清），继续换下一个号。
// kind='genfail' 表示「连续 3 次生成不出图」，文案与额度分开，但计数/上限/已试列表完全共用。
function suiteBatchTryAutoSwitch(row,kind){
    const genFail=kind==='genfail';
    if(suiteBatchAutoSwitchRunning)return;
    if(!suiteBatchState)return;
    if(suiteBatchAttempts>=SUITE_BATCH_SWITCH_LIMIT){
        var over=genFail
            ?'已尝试 '+suiteBatchAttempts+' 个账号仍生成不出图（不支持生图），队列已暂停'
            :'已尝试 '+suiteBatchAttempts+' 个账号仍无额度，队列已暂停';
        suiteBatchTriedAccounts=[];suiteBatchAttempts=0;
        suiteBatchState.paused=true;suiteBatchState.pausedReason=over;saveSuiteBatch();
        showToast('⚠️ '+over);
        if(typeof console!=='undefined')console.warn('🔀 '+over);
        return;
    }
    suiteBatchAttempts++;
    suiteBatchAutoSwitchRunning=true;
    var finish=function(){suiteBatchAutoSwitchRunning=false;};
    var later=typeof setTimeout==='function'?setTimeout:function(fn){Promise.resolve().then(fn);};
    // 已试过的号全部排除：切过又不可用的号不能再切回去
    suiteBatchAutoSwitchMessage(suiteBatchTriedAccounts).then(function(res){
        // 队列已换（重开/换文件）：不接管
        if(!suiteBatchState||suiteBatchState.rows[suiteBatchState.index]!==row)return;
        var name=String((res&&res.name)||'').trim();
        if(res&&res.ok===true&&name){
            if(suiteBatchTriedAccounts.indexOf(name)<0)suiteBatchTriedAccounts.push(name);
            if(typeof console!=='undefined')console.log('🔀 第 '+suiteBatchAttempts+' 次换号'+(genFail?'（不支持生图）':'')+'：已切到 '+name+'，重跑 row'+row);
            try{localStorage.removeItem('polo_suite_auto_v1');}catch(_){}
            try{suiteAutoState=null;}catch(_){}
            if(typeof renderSuiteAutoControls==='function')renderSuiteAutoControls();
            suiteBatchState.paused=false;
            suiteBatchState.pausedReason='';
            saveSuiteBatch();
            showToast('🔀 已切到 '+name+'，重跑第 '+row+' 行');
            later(function(){if(!suiteBatchRunning)runSuiteBatch();},0);
            return;
        }
        // 失败：一律收尾（计数清零），给出能看出"试了几个号"的原因。
        // 原「额度已用完（预计 … 恢复）」/「不支持生图」文案必须保留在原因里：它同时是给人看的信息。
        var tried=suiteBatchTriedAccounts.length;
        var base=String(suiteBatchState.pausedReason||'');
        if(genFail){if(base.indexOf('不支持生图')<0)base='该账号不支持生图';}
        else if(base.indexOf('额度')<0)base='豆包额度已用完';
        var text;
        if(res&&res.reason==='allExhausted')text=genFail
            ?'所有账号均已判定不可用（不支持生图，已试 '+tried+' 个号）'
            :'所有账号额度均已用完（已试 '+tried+' 个号）';
        else text=base+'；自动切号失败（已试 '+tried+' 个号）：'+((res&&res.error)||(res&&res.reason)||'未知原因');
        suiteBatchTriedAccounts=[];suiteBatchAttempts=0;
        suiteBatchState.paused=true;
        suiteBatchState.pausedReason=text;
        saveSuiteBatch();
        if(typeof console!=='undefined')console.warn('🔀 '+text);
        showToast('⚠️ '+text);
    },function(e){
        if(typeof console!=='undefined')console.warn('套图自动切号失败：'+((e&&e.message)||e));
        if(!suiteBatchState)return;
        var tried=suiteBatchTriedAccounts.length;
        var base=String(suiteBatchState.pausedReason||'');
        if(genFail){if(base.indexOf('不支持生图')<0)base='该账号不支持生图';}
        else if(base.indexOf('额度')<0)base='豆包额度已用完';
        suiteBatchTriedAccounts=[];suiteBatchAttempts=0;
        suiteBatchState.paused=true;
        suiteBatchState.pausedReason=base+'；自动切号失败（已试 '+tried+' 个号）：'+((e&&e.message)||e);
        saveSuiteBatch();
    }).then(finish,finish);
}
// 豆包额度用完：整批暂停，不是这一行失败。
// runSuiteFiveJob 会吞掉异常、只把 phase:'error'（及 error 文案）写进自动状态，所以从状态里读，不看 catch。
// 命中后：行不前进（恢复后重跑它）、不记 failed、不进补跑轮（额度问题补跑必败）。
// options.autoSwitch===false 用于补跑轮：补跑遇到额度只暂停，不再触发切号。
function suiteBatchQuotaPause(row,options){
    const state=readSuiteAutoState();
    if(!state||state.fileKey!==suiteBatchState.fileKey||state.rowNum!==row||state.phase!=='error')return null;
    const text=String(state.error||'');
    if(!/额度\s*[,，]?\s*已\s*用完/.test(text))return null;
    const hit=/预计\s*(.+?)\s*恢复/.exec(text);
    const resumeAt=hit?hit[1].trim():'';
    const reason='豆包额度已用完'+(resumeAt?'（预计 '+resumeAt+' 恢复）':'');
    suiteBatchState.paused=true;
    suiteBatchState.pausedReason=reason;
    saveSuiteBatch();
    showToast('⚠️ '+reason+'，队列已暂停');
    if(!(options&&options.autoSwitch===false))suiteBatchTryAutoSwitch(row);
    return {resumeAt,reason};
}
async function runSuiteBatch(){
    if(suiteBatchRunning||!suiteBatchState)return;
    if(suiteBatchState.fileKey!==currentFileKey()){showToast('请导入套图队列所属 Excel 后继续');return;}
    window.UnifiedTaskStarted?.();
    suiteBatchRunning=true;suiteBatchState.paused=false;suiteBatchState.pausedReason='';saveSuiteBatch();
    try{
        while(suiteBatchState.index<suiteBatchState.rows.length&&!suiteBatchState.paused){
            if(currentFileKey()!==suiteBatchState.fileKey)throw Error('Excel 已切换，套图队列已暂停');
            const row=suiteBatchState.rows[suiteBatchState.index];
            const complete=await suiteBatchRunRow(row,false);
            if(complete){suiteBatchGenOk(row);suiteBatchState.index++;saveSuiteBatch();continue;}
            // 用户主动暂停不算失败：当前行保留待续跑，不能登记失败也不能跳过。
            if(suiteBatchState.paused)break;
            // 豆包额度用完：整批暂停，当前行保留待续跑（不记失败、不前进、不补跑）。
            if(suiteBatchQuotaPause(row))break;
            // 连续 3 次一张图都生成不出来（被平台限制的号）：换号后原地重跑本行，同样不记失败。
            if(await suiteBatchGenFailGate(row))break;
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
                if(complete){suiteBatchGenOk(row);suiteBatchState.failed=suiteBatchState.failed.filter(r=>r!==row);}
                else{
                    if(suiteBatchQuotaPause(row,{autoSwitch:false}))break;   // 补跑时遇到额度用完：整批暂停，且不再触发切号（不进第二轮补跑）
                    await suiteBatchDropRow(row);         // 仍失败：保留在 failed，不再补跑
                }
                saveSuiteBatch();
            }
        }
        if(suiteBatchState.index>=suiteBatchState.rows.length){
            suiteBatchState.completed=true;suiteBatchState.paused=false;saveSuiteBatch();
            suiteBatchTriedAccounts=[];suiteBatchAttempts=0;   // 批次结束：换号记录清零
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
        suiteBatchTriedAccounts=[];suiteBatchAttempts=0;   // 新批次：换号记录清零
    }
    await runSuiteBatch();
};
