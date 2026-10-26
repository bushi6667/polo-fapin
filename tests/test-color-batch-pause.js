// ============================================================
// 换色：资源暂停后在途款完成 处理 验收测试
// 方式：从 发品助手.html 中**按名字抽取真实生产函数源码**，放进 Node vm 运行；
//       只模拟 DOM / localStorage / 计时器 / 消息，不复制任何业务逻辑。
// 运行：node tests/test-color-batch-pause.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');

// 按行抽取顶层函数（HTML 内这些函数都是列 0 的 `}` 收尾）
function extractFn(name) {
    const lines = HTML.split('\n').map(l => l.replace(/\r$/, ''));
    const startRe = new RegExp('^function\\s+' + name + '\\s*\\(');
    let s = -1;
    for (let i = 0; i < lines.length; i++) { if (startRe.test(lines[i])) { s = i; break; } }
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) { if (lines[j] === '}') return lines.slice(s, j + 1).join('\n'); }
    throw new Error('函数未闭合: ' + name);
}

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

// ---------- 被测源码（真实生产函数） ----------
const FN_NAMES = [
    'handleColorTaskAccepted', 'handleColorTaskStopped', 'computeColorResumeRows', 'refreshColorResumeRowsFromState', 'advanceBatchColorForRow',
    'setColorResumeRows', 'getColorResumeRows', 'finishBatchColor', 'resumeColorBatch',
    'setupBatchColorTimeout', 'startBatchColorPolling',
    'getColorTimeoutRows', 'setColorTimeoutRows', 'syncBatchColorTimeoutActions',
    'judgeColorTaskResult', 'currentFileKey', 'saveColorBatchState', 'loadColorBatchState',
    'restoreColorBatchState', 'handleColorFileSwitched', 'colorBatchFileKey'
    , 'stopBatchColorChange'
];

// 四色齐全的成功结果（生产判定要求 white/black/gray/navy 全部 ok）
const OK_RESULTS = () => ({
    success: true,
    downloads: ['white', 'black', 'gray', 'navy'].map(c => ({ ok: true, filename: `row1_${c}.png` }))
});
const PARTIAL_RESULTS = (missing) => ({
    success: false,
    downloads: ['white', 'black', 'gray', 'navy']
        .filter(c => missing.indexOf(c) < 0)
        .map(c => ({ ok: true, filename: `row1_${c}.png` }))
});
const FAILED_RESULTS = () => ({ success: false, error: '上传失败', downloads: [] });
// 抽取顶层 const（例如 COLOR_TIMEOUT_KEY），保证测试用的是生产常量
function extractConst(name) {
    const m = new RegExp('^\\s*const\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(HTML);
    if (!m) throw new Error('未找到常量: ' + name);
    return m[0].trim();
}

// 抽取顶层 let（例如 lastExecStatus），保证测试用的是生产变量
function extractLet(name) {
    const m = new RegExp('^\\s*let\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(HTML);
    if (!m) throw new Error('未找到变量: ' + name);
    return m[0].trim();
}

const SRC = [extractConst('COLOR_RESUME_KEY'), extractConst('COLOR_TIMEOUT_KEY'),
    extractConst('COLOR_BATCH_STATE_KEY')]
    .concat(FN_NAMES.map(extractFn)).join('\n\n');

const COLOR_BATCH_STATE_KEY = 'polo_color_batch_state';

// ---------- 环境 ----------
function createEnv(opts = {}) {
    const store = new Map();
    const toasts = [];
    const log = [];
    let dispatched = 0;
    let beginCalls = 0;
    let storageGetCalls = 0;
    // 新语义观测点：取消在途 / 同款重发 / 推进下一款 / 重发时是否要求开新对话
    let pauseCalls = 0;
    let sendCalls = 0;
    let nextCalls = 0;
    let freshChatAtDispatch = null;
    const timers = [];
    let pollEvent = opts.pollEvent || null;   // 轮询读到的持久化完成事件

    const elStub = () => ({ style: {}, textContent: '', innerHTML: '', disabled: false,
        classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null });

    const sandbox = {
        console: { log: (...a) => log.push(a.join(' ')), warn: (...a) => log.push('WARN ' + a.join(' ')), error() {} },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k)
        },
        document: { getElementById: () => elStub(), querySelector: () => null, querySelectorAll: () => [] },
        // 计时器：把间隔压短以便测试（逻辑仍是真实回调）
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => { const t = setInterval(fn, Math.min(ms, 60)); timers.push(t); return t; },
        clearInterval: (t) => clearInterval(t),
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: (id, req, cb) => {
                    if (req.action === 'pauseColorDispatch') { pauseCalls++; cb({ ok: true }); return; }
                    if (req.action === 'getColorTaskEvents') {
                        sandbox.chrome.storage.local.get([], events => cb({ ok: true, events })); return;
                    }
                    if (opts.execStatusResponse !== undefined) { cb(opts.execStatusResponse); return; }
                    cb({
                        ok: true,
                        exec: { rowNum: opts.execRow || 1301, batchId: 'cb_TEST', state: 'accepted' },
                        engine: opts.engineUnknown
                            ? { ok: false, error: '无引擎响应' }
                            : { ok: true, isProcessing: !!opts.engineBusy },
                        engineKnown: opts.engineUnknown ? false : true,
                        queriedAt: Date.now()
                    });
                }
            },
            storage: { local: {
                get: (keys, cb) => {
                    storageGetCalls++;
                    if (opts.storageGetThrows) { cb({}); return; }
                    const out = {};
                    if (pollEvent) out['color_task_complete_event'] = { ...pollEvent, results: pollEvent.results ? { ...pollEvent.results, downloads: (pollEvent.results.downloads || []).map(d => ({ ...d, filename: d.filename.replace(/^row1_/, 'row' + pollEvent.rowNum + '_') })) } : pollEvent.results };
                    cb(out);
                }
            } }
        },
        BATCH_COLOR_COMPLETE_TIMEOUT: opts.timeoutMs || 80,
        // UI / 依赖 mock
        showToast: (m) => toasts.push(m),
        updateBatchColorProgress: () => {},
        loadColorImagesFromExtension: () => {},
        syncColorResumeButton: () => {},
        restoreBatchColorUI: () => {},
        showBatchColorProgress: () => {},
        stopBatchColorPolling: () => {},
        updateBatchColorStatus: (m) => log.push('STATUS ' + m),
        updateBatchColorFill: () => {},
        setBatchColorToggle: () => {},
        processNextBatchColor: () => { dispatched++; nextCalls++; },
        // 真实 sendNextBatchColor 在派发时一次性消费 freshChatNext（发品助手.html:6137-6138）；
        // 桩只记录派发瞬间的取值并清位，供「重试同款也开新对话、且只消费一次」的断言使用。
        sendNextBatchColor: () => {
            dispatched++; sendCalls++;
            if (sandbox.batchColorState) {
                freshChatAtDispatch = sandbox.batchColorState.freshChatNext === true;
                sandbox.batchColorState.freshChatNext = false;
            }
        },
        beginColorBatch: () => { beginCalls++; },
        buildRowPreviewLines: () => ['preview'],
        confirm: () => (opts.confirmAnswer !== undefined ? opts.confirmAnswer : !opts.confirmReject),
        EXTENSION_ID: 'test-extension-id',
        colorPollTimer: null,
        psPollTimer: null,
        products: [],
        loadedFileName: 'A文件.xlsx',
        // 测试注入的"外部执行结果"（模拟 content 回报）：默认四色齐全成功
        __results: JSON.parse(JSON.stringify(opts.results || {
            success: true,
            downloads: ['white', 'black', 'gray', 'navy'].map(c => ({ ok: true, filename: `row1_${c}.png` }))
        })),
        extensionInstalled: true,
        batchColorState: null,
        // finishBatchColor 调用记录：[completed, reason]
        __finishCalls: []
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext('var batchColorState = null;', ctx);
    vm.runInContext(SRC, ctx, { filename: '发品助手.html:color-fns' });
    // 包一层真实 finishBatchColor：只记录调用参数，行为完全不变
    vm.runInContext('var __realFinishBatchColor = finishBatchColor;\n'
        + 'finishBatchColor = function (completed, reason) { __finishCalls.push([completed, reason]); return __realFinishBatchColor(completed, reason); };', ctx);

    return {
        ctx,
        store, toasts, log,
        get dispatched() { return dispatched; },
        get beginCalls() { return beginCalls; },
        get storageGetCalls() { return storageGetCalls; },
        get pauseCalls() { return pauseCalls; },
        get sendCalls() { return sendCalls; },
        get nextCalls() { return nextCalls; },
        get freshChatAtDispatch() { return freshChatAtDispatch; },
        get finishCalls() { return sandbox.__finishCalls; },
        setPollEvent: (e) => { pollEvent = e; },
        run: (expr) => vm.runInContext(expr, ctx),
        clearTimers: () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } },
        setState: (s) => {
            if (s && s.inFlightRow && sandbox.__results && sandbox.__results.downloads) {
                sandbox.__results.downloads = sandbox.__results.downloads.map(d => ({ ...d, filename: d.filename.replace(/^row1_/, 'row' + s.inFlightRow + '_') }));
            }
            sandbox.batchColorState = s; vm.runInContext('batchColorState = __s;', Object.assign(ctx, { __s: s })); }
    };
}

function mkState(rows, opts = {}) {
    return {
        running: opts.running !== undefined ? opts.running : true,
        stopRequested: !!opts.stopRequested,
        queue: rows.map((r, i) => ({ row: r, _idx: i })),
        currentIndex: opts.currentIndex || 0,
        successCount: opts.successCount || 0,
        failCount: 0,
        startTime: Date.now(),
        startRow: rows[0],
        lastAdvancedRow: null,
        lastProcessedTimestamp: 0,
        pollTimer: null,
        label: '批量换色',
        failedRows: opts.failedRows || [],
        lastMemMB: 0,
        batchId: opts.batchId || 'cb_TEST',
        inFlightRow: opts.inFlightRow !== undefined ? opts.inFlightRow : rows[0],
        inFlightSince: Date.now(),
        timedOutRows: opts.timedOutRows || [],
        pausedReason: ''
    };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ============================================================
(async function main() {
    console.log('换色暂停/继续：按当前要求覆盖生产函数');
    const env=createEnv(); const st=mkState([412,415],{inFlightRow:412});
    st.executionId='OLD'; env.setState(st); env.ctx.products=st.queue;
    env.run('stopBatchColorChange()');
    ok(!st.running && st.inFlightRow===null,'暂停立即清除执行等待');
    ok(st.currentIndex===0 && st.successCount===0,'暂停保留当前款，未记成功');
    ok(env.run('getColorResumeRows().join()')==='412,415','当前款仍在继续列表');
    env.run("advanceBatchColorForRow(412,'message','cb_TEST',__results)");
    ok(st.successCount===0 && env.dispatched===0,'暂停后的旧完成不入账、不派发');
    env.ctx.confirm=()=>{throw new Error('继续不应要求确认');};
    const oldBatch=st.batchId; env.run('resumeColorBatch()');
    ok(st.running && env.dispatched===1,'继续直接重新派发，不查询、不确认');
    ok(st.currentIndex===0 && st.batchId!==oldBatch,'从当前款重启并隔离旧批次消息');
    env.run('stopBatchColorChange()');
    ok(!st.running && env.dispatched===1,'再次暂停有效');
    env.clearTimers();

    // ---- 第一次超时：取消在途 → 同款重试 1 次（不暂停整批、不前进） ----
    const timeout=createEnv({timeoutMs:20}); const ts=mkState([421,422],{inFlightRow:421});
    ts.executionId='CE1';
    timeout.setState(ts); timeout.ctx.products=ts.queue;
    timeout.run('setupBatchColorTimeout({row:421})'); await tick(40);
    ok(ts.running===true && !ts.stopRequested,'第一次超时不暂停整批');
    ok(ts.currentIndex===0 && ts.inFlightRow===null,'第一次超时不前进当前款');
    ok(ts.retryOf===421,'第一次超时标记「同款重试」');
    ok(timeout.pauseCalls===1,'超时先发 pauseColorDispatch 取消在途再重发');
    ok(timeout.sendCalls===1 && timeout.nextCalls===0,'同款被重新派发（走重发通道，不是推进下一款）');
    ok(timeout.freshChatAtDispatch===true && ts.freshChatNext===false,'重试同款也先开新对话，且标记只消费一次');
    ok(timeout.run('getColorTimeoutRows().length')===0,'无查询确认门槛');

    // ---- 第二次超时（同一 row 连续两次）：记失败 + 跳过 + 下一款开新对话 ----
    ts.inFlightRow=421; ts.inFlightSince=Date.now(); ts.executionId='CE2';   // 模拟重试已发出
    timeout.run('setupBatchColorTimeout({row:421})'); await tick(40);
    ok(ts.failedRows.includes(421),'同款连续两次超时记入失败款');
    ok(ts.currentIndex===1 && ts.inFlightRow===null,'第二次超时跳到下一款');
    ok(ts.freshChatNext===true,'跳过后下一款先开新对话（防迟到图串款）');
    ok(ts.retryOf===null,'重试标记已清，不会无限重试');
    ok(timeout.pauseCalls===2,'两次超时各取消一次在途执行');
    ok(timeout.finishCalls.filter(c=>c[0]===false).length===0,'二次超时未调用 finishBatchColor(false)（整批不暂停）');
    ok(ts.running===true && timeout.nextCalls===1,'二次超时后继续派发下一款');
    timeout.clearTimers();

    const restored=createEnv(); restored.ctx.products=[{row:486},{row:490}];
    restored.store.set(COLOR_BATCH_STATE_KEY, JSON.stringify({rows:[486,490],currentIndex:0,fileKey:'A文件_xlsx__',fileFolder:'A文件.xlsx',batchId:'OLD',inFlightRow:486,pendingAckRow:486,inFlightSince:Date.now()}));
    ok(restored.run('restoreColorBatchState()')===true,'旧600款缓存同样可恢复');
    ok(restored.run('batchColorState.running===false && batchColorState.inFlightRow===null'),'刷新保持暂停，不宣称仍在生成');
    restored.run('resumeColorBatch()'); ok(restored.dispatched===1,'刷新后继续直接执行暂停款'); restored.clearTimers();

    const closed=createEnv(); const cs=mkState([490,491],{inFlightRow:490}); cs.executionId='E'; closed.setState(cs); closed.ctx.products=cs.queue;
    closed.run("handleColorTaskStopped({batchId:'cb_TEST',executionId:'OTHER'})");
    ok(cs.running,'其他任务关页通知不能干扰');
    closed.run("handleColorTaskStopped({batchId:'cb_TEST',executionId:'E'})");
    ok(!cs.running && cs.currentIndex===0 && cs.inFlightRow===null,'豆包关页后立即显示暂停'); closed.clearTimers();

    // ---- 报错类失败：不重试，直接记失败并跳款（整批继续） ----
    const judge=createEnv(); const js=mkState([412,415],{inFlightRow:412}); js.executionId='J1';
    judge.setState(js); judge.ctx.products=js.queue;
    ok(!judge.run("judgeColorTaskResult({downloads:[]},412).ok"),'无下载仍不能误报成功');
    judge.run("advanceBatchColorForRow(412,'message','cb_TEST',{downloads:[]})");
    ok(js.failedRows.includes(412) && js.failCount===1,'报错类失败记入失败款');
    ok(js.currentIndex===1 && js.inFlightRow===null,'报错类失败直接跳到下一款');
    ok(js.running===true && !js.stopRequested,'报错类失败不暂停整批');
    ok(js.retryOf===null && judge.sendCalls===0,'报错类失败不重试（无同款重发）');
    ok(judge.finishCalls.filter(c=>c[0]===false).length===0,'报错类失败未调用 finishBatchColor(false)');
    ok(js.freshChatNext===true,'跳过后下一款先开新对话（防迟到图串款）');
    ok(judge.nextCalls===1,'失败后立即推进下一款');
    // 补跑/重发同一款成功：失败记录被修正，且只入账一次
    js.currentIndex=0; js.inFlightRow=412; js.inFlightSince=Date.now(); js.executionId='J2'; js.lastAdvancedRow=null;
    judge.run("advanceBatchColorForRow(412,'message',batchColorState.batchId,__results)");
    ok(js.successCount===1 && js.failCount===0 && js.failedRows.length===0,'重做成功后修正失败记录，仅入账一次');
    judge.run("advanceBatchColorForRow(412,'message',batchColorState.batchId,__results)");
    ok(js.successCount===1,'重复完成不双计');
    ok(!judge.run("judgeColorTaskResult({downloads:[{filename:'row999_white.png',ok:true}]},412).ok"),'其他行的下载不能冒充本行结果');
    judge.clearTimers();

    // ---- 补跑一轮：收尾时把失败款追加到队尾，只补一次 ----
    const sup=createEnv(); const ss=mkState([431,432],{inFlightRow:null});
    ss.currentIndex=2; ss.successCount=1; ss.failedRows=[431]; ss.failCount=1;
    sup.setState(ss); sup.ctx.products=[{row:431},{row:432}];
    sup.run('finishBatchColor(true)');
    ok(ss.queue.length===3 && ss.queue[2].row===431,'收尾时失败款追加到队尾补跑');
    ok(ss.supplementDone===true && ss.failedRows.length===0,'补跑只登记一次并清空失败款记录');
    ok(ss.running===true && sup.nextCalls===1,'补跑立即派发且整批保持运行');
    ss.currentIndex=3; ss.inFlightRow=null; ss.running=true;
    sup.run('finishBatchColor(true)');
    ok(ss.queue.length===3 && ss.supplementDone===true,'第二次收尾不再追加补跑');
    ok(ss.running===false,'补跑后正常收尾（running=false）');
    sup.clearTimers();
    const legacy=createEnv({confirmReject:true}); legacy.ctx.products=[{row:412},{row:415}];
    legacy.run('setColorResumeRows([412,415]); resumeColorBatch()');
    ok(legacy.beginCalls===1,'仅有旧待办列表也直接继续，不弹确认'); legacy.clearTimers();
    console.log('通过 '+pass+'，失败 '+fail); process.exit(fail?1:0);
})();
