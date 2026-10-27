// ============================================================
// 豆包额度用完 → 自动切到有额度的账号继续跑 验收测试
//   换色：advanceBatchColorForRow 额度分支 → doubaoAutoSwitch（发品助手.html，真实函数抽取进 vm）
//   套图：suiteBatchQuotaPause → doubaoAutoSwitch（suite-batch.js，整文件装载）
// 所有账号都没额度才暂停；切号失败不得把当前款记成失败。
// 运行：node tests/test-account-autoswitch.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

// ---------- 换色：从 HTML 抽取真实生产函数 ----------
function extractFn(name) {
    const lines = HTML.split('\n').map(l => l.replace(/\r$/, ''));
    const startRe = new RegExp('^function\\s+' + name + '\\s*\\(');
    let s = -1;
    for (let i = 0; i < lines.length; i++) { if (startRe.test(lines[i])) { s = i; break; } }
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) { if (lines[j] === '}') return lines.slice(s, j + 1).join('\n'); }
    throw new Error('函数未闭合: ' + name);
}
function extractConst(name) {
    const m = new RegExp('^\\s*const\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(HTML);
    if (!m) throw new Error('未找到常量: ' + name);
    return m[0].trim();
}
function extractLet(name) {
    const m = new RegExp('^\\s*(?:let|var)\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(HTML);
    if (!m) throw new Error('未找到变量: ' + name);
    return m[0].trim();
}

const COLOR_FNS = [
    'advanceBatchColorForRow', 'judgeColorTaskResult', 'finishBatchColor', 'resumeColorBatch',
    'computeColorResumeRows', 'refreshColorResumeRowsFromState', 'saveColorBatchState',
    'setColorResumeRows', 'getColorResumeRows', 'setColorTimeoutRows', 'getColorTimeoutRows',
    'stopBatchColorPolling', 'startBatchColorPolling', 'colorBatchFileKey', 'currentFileKey',
    // ↓ 自动切号
    'doubaoAccountMessage', 'colorQuotaAutoSwitch', 'applyColorAutoSwitch', 'restartColorBatchForRow'
];
const COLOR_SRC = [extractConst('COLOR_BATCH_STATE_KEY'), extractConst('COLOR_RESUME_KEY'),
    extractConst('COLOR_TIMEOUT_KEY'), extractLet('colorAutoSwitchRunning'),
    extractLet('colorQuotaTriedAccounts'), extractLet('colorQuotaAttempts'),
    extractLet('COLOR_QUOTA_SWITCH_LIMIT')]
    .concat(COLOR_FNS.map(extractFn)).join('\n\n');

const OK_RESULTS = (row) => ({
    success: true,
    downloads: ['white', 'black', 'gray', 'navy'].map(c => ({ ok: true, filename: `row${row}_${c}.png` }))
});
const QUOTA_ARGS = "{exhausted:true,text:'QUOTA_EXHAUSTED：额度已用完（预计 10 月 25 日 03:24 恢复）',resumeAt:'10 月 25 日 03:24'}";

function colorEnv(opts = {}) {
    const store = new Map();
    const toasts = [];
    const statuses = [];
    const reqs = [];
    let dispatched = 0;
    let dispatchedRow = null;
    let autoSwitchCalls = 0;
    const elStub = () => ({ style: {}, textContent: '', innerHTML: '', disabled: false,
        classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null });
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k)
        },
        document: { getElementById: () => elStub(), querySelector: () => null, querySelectorAll: () => [] },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: t => clearTimeout(t),
        setInterval: () => 0,          // 轮询通道不在本组范围，避免真定时器拖住进程
        clearInterval: () => {},
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: (id, req, cb) => {
                    reqs.push({ id, req });
                    if (req && req.action === 'doubaoAutoSwitch') {
                        autoSwitchCalls++;
                        if (opts.autoSwitchThrows) throw new Error(opts.autoSwitchThrows);
                        const res = typeof opts.autoSwitch === 'function'
                            ? opts.autoSwitch(req)
                            : (opts.autoSwitch || { ok: true, name: '用户131 2997' });
                        if (cb) cb(res);
                        return;
                    }
                    if (cb) cb({ ok: true });
                }
            }
        },
        showToast: m => toasts.push(m),
        updateBatchColorProgress() {},
        updateBatchColorStatus: m => statuses.push(m),
        updateBatchColorFill() {},
        restoreBatchColorUI() {},
        setBatchColorToggle() {},
        syncColorResumeButton() {},
        syncBatchColorTimeoutActions() {},
        processNextBatchColor: () => { dispatched++; },
        sendNextBatchColor: () => {
            dispatched++;
            dispatchedRow = sandbox.batchColorState
                ? sandbox.batchColorState.queue[sandbox.batchColorState.currentIndex].row : null;
        },
        showBatchColorProgress() {},
        extensionInstalled: true,
        EXTENSION_ID: 'test-extension-id',
        colorPollTimer: null,
        products: [],
        loadedFileName: 'A文件.xlsx',
        batchColorState: null
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext('var batchColorState = null;', ctx);
    vm.runInContext(COLOR_SRC, ctx, { filename: '发品助手.html:autoswitch-fns' });
    return {
        ctx, store, toasts, statuses, reqs,
        get dispatched() { return dispatched; },
        get dispatchedRow() { return dispatchedRow; },
        get autoSwitchCalls() { return autoSwitchCalls; },
        run: expr => vm.runInContext(expr, ctx),
        setState: s => { sandbox.batchColorState = s; vm.runInContext('batchColorState = __s;', Object.assign(ctx, { __s: s })); }
    };
}

function mkColorState(rows, opts = {}) {
    return {
        running: true, stopRequested: false,
        queue: rows.map((r, i) => ({ row: r, _idx: i })),
        currentIndex: opts.currentIndex || 0,
        successCount: 0, failCount: 0,
        startTime: Date.now(), startRow: rows[0],
        lastAdvancedRow: null, lastProcessedTimestamp: 0, pollTimer: null,
        label: '批量换色', failedRows: opts.failedRows || [], lastMemMB: 0,
        batchId: 'cb_TEST', executionId: opts.executionId || null,
        inFlightRow: opts.inFlightRow !== undefined ? opts.inFlightRow : rows[0],
        inFlightSince: Date.now(), pendingAckRow: null, timedOutRows: [],
        freshChatNext: false, supplementDone: false, pausedReason: ''
    };
}
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

// ---------- 套图：整文件装载（与 tests/test-suite-batch.js 同风格） ----------
const SUITE_SRC = fs.readFileSync(path.join(__dirname, '..', 'suite-batch.js'), 'utf8');
const STEPS = ['111', '444', '222', '333', '666'];
const QUOTA_TEXT = 'QUOTA_EXHAUSTED：额度已用完（预计 10 月 25 日 03:24 恢复）';

function suiteEnv(options) {
    const opt = options || {};
    const quotaOnce = Object.assign({}, opt.quotaOnce || {});
    const fails = Object.assign({}, opt.fails || {});
    const calls = [], toasts = [], marks = [], storage = new Map(), reqs = [];
    let autoSwitchCalls = 0;
    const current = { row: 2 };
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: t => clearTimeout(t),
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: (id, req, cb) => {
                    reqs.push({ id, req });
                    if (req && req.action === 'doubaoAutoSwitch') {
                        autoSwitchCalls++;
                        const res = typeof opt.autoSwitch === 'function'
                            ? opt.autoSwitch(req)
                            : (opt.autoSwitch || { ok: true, name: '用户131 2997' });
                        if (cb) cb(res);
                        return;
                    }
                    if (cb) cb({ ok: true });
                }
            }
        },
        EXTENSION_ID: 'test-extension-id',
        localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        products: [{ row: 2 }, { row: 3 }, { row: 4 }], currentProduct: current, currentFileKey: () => 'book',
        showToast: m => {
            toasts.push(m);
            // 打点：切换成功那一刻队列停在哪、paused 是否已复位
            if (/已切到/.test(m) && sandbox.suiteBatchState) {
                marks.push({ index: sandbox.suiteBatchState.index,
                    paused: sandbox.suiteBatchState.paused,
                    failed: (sandbox.suiteBatchState.failed || []).slice() });
            }
        },
        suiteTaskRunning: false, batchColorState: null, SUITE_STEP_KEYS: STEPS,
        readSuiteAutoState: () => {
            if (sandbox.suiteAutoState) return sandbox.suiteAutoState;
            try {
                const v = JSON.parse(storage.get('polo_suite_auto_v1') || 'null');
                if (v && v.fileKey && Number.isInteger(v.rowNum)) sandbox.suiteAutoState = v;
            } catch (_) {}
            return sandbox.suiteAutoState;
        },
        saveSuiteAutoState: s => { storage.set('polo_suite_auto_v1', JSON.stringify(s)); sandbox.suiteAutoState = s; },
        selectProduct: i => { sandbox.currentProduct = sandbox.products[i]; },
        cancelSuiteProductTasks: async () => {},
        renderSuiteAutoControls() {},
        runSuiteFiveJob: async opts => {
            const row = sandbox.currentProduct.row, restart = !!(opts && opts.restart);
            calls.push({ row, restart });
            // 与 runSuiteFiveJob 的 catch 一致：异常被吞，只把 phase:'error' 与 error 文案写进自动状态
            if (!restart && quotaOnce[row] > 0) {
                quotaOnce[row]--;
                sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'error', paused: true, error: QUOTA_TEXT });
                return null;
            }
            if (!restart && fails[row] > 0) {
                fails[row]--;
                sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'error', paused: true, error: '上传失败' });
                return null;
            }
            sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'completed' });
            return null;
        },
        SuiteCore: { ResultStore: () => ({ list: async () => STEPS.map(key => ({ key, blob: { size: 1 } })) }) },
        suiteAutoState: null
    };
    sandbox.window = {};
    vm.createContext(sandbox);
    vm.runInContext(SUITE_SRC, sandbox);
    return { sandbox, calls, toasts, marks, storage, reqs, get autoSwitchCalls() { return autoSwitchCalls; } };
}

// ---------- 扩展侧：background.js 的 doubaoAutoSwitch 只切号、不探测 ----------
// background.js 是 MV3 service worker，不能 require；这里按行抽取真实函数进 vm，
// 只桩掉 chrome.storage / chrome.tabs.sendMessage（doubaoSendToTab 用桩替代，便于记录发了什么）。
const BG = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'background.js'), 'utf8');
function extractBgFn(name) {
    const lines = BG.split('\n').map(l => l.replace(/\r$/, ''));
    const startRe = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    let s = -1;
    for (let i = 0; i < lines.length; i++) { if (startRe.test(lines[i])) { s = i; break; } }
    if (s < 0) throw new Error('未找到 background 函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) { if (lines[j] === '}') return lines.slice(s, j + 1).join('\n'); }
    throw new Error('background 函数未闭合: ' + name);
}
function extractBgConst(name) {
    const m = new RegExp('^const\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(BG);
    if (!m) throw new Error('未找到 background 常量: ' + name);
    return m[0].trim();
}
const BG_FNS = ['doubaoLocalDateKey', 'doubaoEmptyLedger', 'doubaoNormStatus', 'doubaoLoadLedger',
    'doubaoSaveLedger', 'doubaoIsAccountBusy', 'doubaoSwitchForScan', 'doubaoNextProbeSeq',
    'doubaoWriteProbe', 'doubaoMergeAccountList', 'doubaoReadCurrentName', 'doubaoIsFreshExhausted',
    'doubaoProbeOrder', 'doubaoBuildCandidates', 'doubaoAutoSwitchAction'];
const BG_SRC = ['DOUBAO_LEDGER_KEY', 'DOUBAO_STATUS_OK', 'DOUBAO_STATUS_EXHAUSTED',
    'DOUBAO_STATUS_UNSUPPORTED', 'DOUBAO_STATUS_UNKNOWN', 'DOUBAO_CHANNEL_CLOSED_RE'].map(extractBgConst)
    .concat(['var doubaoScanInFlight = false;'])
    .concat(BG_FNS.map(extractBgFn)).join('\n\n');

function dateKeyNow() {
    const d = new Date(), p = n => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// 账本：acct1..acct10，acct1 是当前号（今天出过图），其余 unknown
function mkLedger(statuses) {
    const accounts = {};
    Object.keys(statuses || {}).forEach((name, i) => {
        accounts[name] = { plan: 'pro', status: statuses[name], percent: null, label: '',
            checkedAt: Date.now(), note: '', resumeAt: '', missing: false, probeSeq: i + 1 };
    });
    return { dateKey: dateKeyNow(), updatedAt: Date.now(), accounts };
}

function bgEnv(opts) {
    const o = opts || {};
    const store = new Map();
    const sent = [], switches = [];
    if (o.ledger) store.set('polo_doubao_accounts_v1', o.ledger);
    const sb = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: t => clearTimeout(t),
        chrome: {
            storage: {
                local: {
                    get: async k => ({ [k]: store.get(k) }),
                    set: async obj => { Object.keys(obj).forEach(k => store.set(k, obj[k])); }
                }
            }
        },
        findDoubaoTab: async () => ({ id: 7 }),
        getActiveColorExec: async () => null,
        recoverDoubaoAccountSwitch: async () => ({ ok: false, reloaded: true, error: '通道断开' }),
        __current: o.current || '',
        doubaoSendToTab: (tabId, payload) => {
            sent.push(payload.action);
            if (payload.action === 'doubaoListAccounts') {
                return Promise.resolve({ ok: true, current: sb.__current,
                    accounts: (o.accounts || []).map(n => ({ name: n })) });
            }
            if (payload.action === 'doubaoSwitchAccount') {
                switches.push(payload.name);
                const r = (o.switchFn ? o.switchFn(payload.name) : { ok: true }) || {};
                if (r.ok === true) sb.__current = payload.name;
                return Promise.resolve(r);
            }
            if (payload.action === 'doubaoBusyState') return Promise.resolve(o.busyState || { ok: true, busy: false });
            return Promise.resolve({ ok: false, error: '未预期的 action: ' + payload.action });
        }
    };
    vm.createContext(sb);
    vm.runInContext(BG_SRC, sb, { filename: 'background.js:autoswitch-fns' });
    return {
        sb, store, sent, switches,
        ledger: () => store.get('polo_doubao_accounts_v1'),
        call: req => sb.doubaoAutoSwitchAction(req || {})
    };
}

// ---------- 内容脚本侧：忙态合成（从 content/doubao.js 抽真实函数） ----------
const DOUBAO_JS = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'content', 'doubao.js'), 'utf8');
const SUITE_DOUBAO_SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'suite', 'suite-doubao.js'), 'utf8');

function sliceFn(src, name) {
    const lines = src.split('\n').map(l => l.replace(/\r$/, ''));
    const startRe = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const s = lines.findIndex(l => startRe.test(l));
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) if (lines[j] === '}') return lines.slice(s, j + 1).join('\n');
    throw new Error('函数未闭合: ' + name);
}
function sliceDecl(src, name) {
    const m = new RegExp('^\\s*(?:var|const|let)\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(src);
    if (!m) throw new Error('未找到声明: ' + name);
    return m[0].trim();
}
const lit = s => { const m = /'([^']*)'/.exec(String(s || '')); return m ? m[1] : ''; };

const BUSY_SRC = ['DOUBAO_BUSY_SEL', 'DOUBAO_QUOTA_RECENT_MS', '__quotaFailedAt'].map(n => sliceDecl(DOUBAO_JS, n))
    .concat([sliceDecl(DOUBAO_JS, 'isProcessing')])
    .concat(['isDoubaoVisible', 'isDoubaoQuotaRecent', 'isDoubaoBusyInDom', 'doubaoComputeBusyState'].map(n => sliceFn(DOUBAO_JS, n)))
    .join('\n\n');

// busyEls：DOM 里"可见的生成中节点"个数（0 = 页面不忙）
function busyEnv(opts) {
    const o = opts || {};
    const els = Array.from({ length: o.busyEls || 0 }, () => ({ getClientRects: () => [{}], offsetHeight: 12 }));
    const sb = { console: { log() {}, warn() {}, error() {} }, Date, Number, String, Array, Object,
        document: { querySelectorAll: () => els } };
    vm.createContext(sb);
    vm.runInContext(BUSY_SRC, sb, { filename: 'doubao.js:busy-fns' });
    return {
        sb,
        state: () => sb.doubaoComputeBusyState(),
        // 模拟"刚被额度拒过 ms 毫秒"（ms 很大 = 窗口早就过去了）
        setQuotaAgo: ms => vm.runInContext('__quotaFailedAt = Date.now() - ' + Number(ms) + ';', sb),
        clearQuota: () => vm.runInContext('__quotaFailedAt = 0;', sb),
        setProcessing: v => vm.runInContext('isProcessing = ' + (v ? 'true' : 'false') + ';', sb)
    };
}

// ============================================================
(async function main() {
    console.log('额度用完 → 自动切号继续跑');

    // ---- 1) 换色：额度命中 → 自动切号成功 → 不记失败、不前进、重跑当前款 ----
    {
        const env = colorEnv();
        const st = mkColorState([412, 415, 418], { inFlightRow: 415, currentIndex: 1 });
        const oldBatchId = st.batchId;
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(OK_RESULTS(415))},${QUOTA_ARGS})`);

        ok(st.running === false && st.stopRequested === true, '额度命中：先暂停（可恢复），批次不结束');
        ok(/正在查找有额度的账号/.test(st.pausedReason), '额度命中：状态显示「正在查找有额度的账号」', st.pausedReason);
        ok(st.currentIndex === 1 && st.inFlightRow === null, '额度命中：停在当前款、清掉在途身份');
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '额度命中：不把本款记成失败');
        ok(env.run('colorAutoSwitchRunning') === true, '额度命中：防重入 flag 已置位');
        ok(env.dispatched === 0, '额度命中：切号结果回来前不派发');

        await tick(60);
        ok(env.autoSwitchCalls === 1, '额度命中：调用了一次 doubaoAutoSwitch', String(env.autoSwitchCalls));
        ok(env.reqs.some(r => r.req.action === 'doubaoAutoSwitch' && r.id === 'test-extension-id'),
            '额度命中：消息带 EXTENSION_ID');
        ok(st.running === true && st.stopRequested === false, '切号成功：批次自动继续（running=true）');
        ok(st.batchId !== oldBatchId && /^bc_/.test(st.batchId), '切号成功：换新 batchId', st.batchId);
        ok(st.freshChatNext === true, '切号成功：freshChatNext 置位（新号先开新对话）');
        ok(st.currentIndex === 1, '切号成功：currentIndex 未前进（仍从 415 重跑）');
        ok(env.dispatched === 1 && env.dispatchedRow === 415, '切号成功：重新派发当前款 415', String(env.dispatchedRow));
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '切号成功：仍不记失败');
        ok(st.pausedReason === '', '切号成功：清空暂停原因');
        ok(env.toasts.some(t => /已切到/.test(t) && /重跑/.test(t)),
            '切号成功：记一条「已切到 X，重跑当前款」', env.toasts.join(' | '));
        ok(env.run('colorAutoSwitchRunning') === false, '切号成功：防重入 flag 已清理');
    }

    // ---- 2) 换色：所有账号都没额度 → 暂停且原因正确 ----
    {
        const env = colorEnv({ autoSwitch: { ok: false, reason: 'allExhausted' } });
        const st = mkColorState([415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(OK_RESULTS(415))},${QUOTA_ARGS})`);
        await tick(60);
        ok(st.running === false, '全部没额度：保持暂停');
        ok(/所有账号额度均已用完/.test(st.pausedReason), '全部没额度：原因含「所有账号额度均已用完」', st.pausedReason);
        ok(st.currentIndex === 0 && env.dispatched === 0, '全部没额度：不前进、不派发');
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '全部没额度：不记失败');
        ok(env.run('colorAutoSwitchRunning') === false, '全部没额度：flag 已清理');
    }

    // ---- 3) 换色：目标账号需要重新登录 → 暂停并提示登录 ----
    {
        const env = colorEnv({ autoSwitch: { ok: false, reason: 'needLogin' } });
        const st = mkColorState([415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(OK_RESULTS(415))},${QUOTA_ARGS})`);
        await tick(60);
        ok(st.running === false, '需要登录：保持暂停');
        ok(/重新登录/.test(st.pausedReason), '需要登录：提示先登录', st.pausedReason);
        ok(st.currentIndex === 0 && env.dispatched === 0, '需要登录：不前进、不派发');
    }

    // ---- 4) 换色：autoSwitch 抛异常 → 暂停、不崩、不记失败 ----
    {
        const env = colorEnv({ autoSwitchThrows: 'Extension context invalidated' });
        const st = mkColorState([415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;
        let crashed = null;
        try {
            env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(OK_RESULTS(415))},${QUOTA_ARGS})`);
        } catch (e) { crashed = e; }
        await tick(60);
        ok(crashed === null, '切号异常：同步调用不抛出', crashed && crashed.message);
        ok(st.running === false && st.currentIndex === 0, '切号异常：保持暂停、不前进');
        ok(/自动切号失败/.test(st.pausedReason) && /Extension context invalidated/.test(st.pausedReason),
            '切号异常：显示原始错误', st.pausedReason);
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '切号异常：不记失败');
        ok(env.dispatched === 0, '切号异常：不派发');
        ok(env.run('colorAutoSwitchRunning') === false, '切号异常：flag 已清理（不卡死后续额度命中）');
    }

    // ---- 5) 换色回归：普通失败（非额度）→ 不调 autoSwitch ----
    {
        const env = colorEnv();
        const st = mkColorState([412, 415], { inFlightRow: 412 });
        env.setState(st); env.ctx.products = st.queue;
        env.run("advanceBatchColorForRow(412,'message','cb_TEST',{downloads:[]})");
        await tick(60);
        ok(env.autoSwitchCalls === 0, '普通失败：不触发自动切号', String(env.autoSwitchCalls));
        ok((st.failedRows || []).includes(412) && st.failCount === 1, '普通失败：仍记入 failedRows');
        ok(st.currentIndex === 1, '普通失败：仍跳到下一款');
        ok(st.running === true && st.pausedReason === '', '普通失败：不暂停整批');
    }

    // ---- 6) 套图：额度 → autoSwitch 成功 → index 不前进且继续跑该行 ----
    {
        const env = suiteEnv({ quotaOnce: { 3: 1 } });
        await env.sandbox.startSuiteGeneration();
        await tick(120);
        const st = env.sandbox.suiteBatchState;
        ok(env.autoSwitchCalls === 1, '套图额度：调用了一次 doubaoAutoSwitch', String(env.autoSwitchCalls));
        ok(env.marks.length === 1 && env.marks[0].index === 1,
            '套图换号成功：index 未前进（仍停在 row3）', JSON.stringify(env.marks));
        ok(env.marks.length === 1 && env.marks[0].paused === false && env.marks[0].failed.length === 0,
            '套图换号成功：paused 复位、未登记失败');
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3,3,4]',
            '套图换号成功：row3 原地重跑而不是跳到下一行', JSON.stringify(env.calls.map(c => c.row)));
        ok(st.paused === false && st.pausedReason === '', '套图换号成功：队列继续（未暂停）');
        ok((st.failed || []).length === 0, '套图换号成功：failed 为空');
        ok(st.index === 3 && st.completed === true, '套图换号成功：整队跑完并完成', `${st.index}/${st.completed}`);
        ok(env.toasts.some(t => /已切到/.test(t) && /重跑第 3 行/.test(t)), '套图换号成功：提示重跑该行');
        const persisted = JSON.parse(env.storage.get('polo_suite_batch_v1'));
        ok(persisted.paused === false, '套图换号成功：暂停已从存档解除');
    }

    // ---- 7) 套图：所有账号都没额度 → paused=true + 原因正确 ----
    {
        const env = suiteEnv({ quotaOnce: { 3: 1 }, autoSwitch: { ok: false, reason: 'allExhausted' } });
        await env.sandbox.startSuiteGeneration();
        await tick(120);
        const st = env.sandbox.suiteBatchState;
        ok(st.paused === true, '套图全没额度：paused=true');
        ok(/所有账号额度均已用完/.test(st.pausedReason || ''), '套图全没额度：原因正确', st.pausedReason);
        ok(st.index === 1, '套图全没额度：index 未前进');
        ok((st.failed || []).length === 0 && st.retryRound === 0, '套图全没额度：不记失败、不进补跑轮');
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3]', '套图全没额度：不再跑下一行',
            JSON.stringify(env.calls.map(c => c.row)));
        ok(st.completed === false, '套图全没额度：不标记完成');
        ok(env.sandbox.suiteBatchRunning === false, '套图全没额度：运行锁已释放');
    }

    // ---- 8) 防重入：连续两次额度命中只触发一次 autoSwitch ----
    {
        const env = colorEnv();
        const st = mkColorState([412, 415], { inFlightRow: 415, currentIndex: 1 });
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(OK_RESULTS(415))},${QUOTA_ARGS})`);
        ok(env.autoSwitchCalls === 1, '防重入：第一次额度命中触发切号');
        env.run("colorQuotaAutoSwitch(412,'豆包额度已用完')");
        ok(env.autoSwitchCalls === 1, '防重入：第二次额度命中不重复调用', String(env.autoSwitchCalls));
        await tick(80);
        ok(env.autoSwitchCalls === 1, '防重入：结算后仍只调用一次');
        ok(env.dispatched === 1, '防重入：只重启一次当前款', String(env.dispatched));
        ok(env.dispatchedRow === 415, '防重入：重启的是最初报额度的那一款', String(env.dispatchedRow));
        ok(env.run('colorAutoSwitchRunning') === false, '防重入：结束后 flag 归零');
    }

    // ============================================================
    // 循环换号：切号成功 → 重跑同一款 → 又弹额度 → 再换下一个号
    // ============================================================
    const hitColorQuota = (env, st, row) => {
        // 模拟「重跑后这一款又报额度」：重新置在途身份与运行态，用当前(新)batchId 投递
        st.inFlightRow = row;
        st.running = true;
        env.run(`advanceBatchColorForRow(${row},'message',${JSON.stringify(st.batchId)},${JSON.stringify(OK_RESULTS(row))},${QUOTA_ARGS})`);
    };
    const switchReqs = env => env.reqs.filter(r => r.req && r.req.action === 'doubaoAutoSwitch').map(r => r.req);

    // ---- 9) 换色循环：连续切到 3 个号，每个都再弹额度，日志/计数/排除列表都要对 ----
    {
        const seq = [{ ok: true, name: '号A' }, { ok: true, name: '号B' }, { ok: true, name: '号C' }];
        let k = 0;
        const env = colorEnv({ autoSwitch: () => seq[Math.min(k++, seq.length - 1)] });
        const st = mkColorState([415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;

        hitColorQuota(env, st, 415); await tick(60);
        ok(env.autoSwitchCalls === 1 && env.run('colorQuotaAttempts') === 1,
            '循环换号：第 1 次额度 → 换号 1 次', String(env.run('colorQuotaAttempts')));
        ok(JSON.stringify(env.run('colorQuotaTriedAccounts.slice()')) === '["号A"]',
            '循环换号：已试列表记下号A', JSON.stringify(env.run('colorQuotaTriedAccounts.slice()')));
        ok(st.running === true && env.dispatched === 1 && env.dispatchedRow === 415,
            '循环换号：重跑同一款 415');

        hitColorQuota(env, st, 415); await tick(60);
        ok(env.autoSwitchCalls === 2, '循环换号：重跑再弹额度 → 第 2 次换号', String(env.autoSwitchCalls));
        hitColorQuota(env, st, 415); await tick(60);
        ok(env.autoSwitchCalls === 3, '循环换号：第 3 次换号', String(env.autoSwitchCalls));
        ok(JSON.stringify(env.run('colorQuotaTriedAccounts.slice()')) === '["号A","号B","号C"]',
            '循环换号：已试列表累积到 3 个号', JSON.stringify(env.run('colorQuotaTriedAccounts.slice()')));
        const ex = switchReqs(env).map(r => r.exclude || []);
        ok(JSON.stringify(ex) === '[[],["号A"],["号A","号B"]]',
            '循环换号：每次 exclude 都带上已试过的号（切过的不再切回去）', JSON.stringify(ex));
        ok(env.run('colorQuotaAttempts') === 3, '循环换号：次数累计为 3', String(env.run('colorQuotaAttempts')));
        ok(env.statuses.some(s => /第 3 次换号：已切到 号C，重跑 row415/.test(s)),
            '循环换号：批次日志写入「第 N 次换号：已切到 X，重跑 rowX」', env.statuses.join(' | '));
        ok(env.dispatched === 3 && st.currentIndex === 0 && !(st.failedRows || []).includes(415),
            '循环换号：3 次都重跑本款，始终不记账失败');
    }

    // ---- 10) 换色上限 12：第 13 次额度命中不再换号，直接暂停并说明试了几个号 ----
    {
        let n = 0;
        const env = colorEnv({ autoSwitch: () => ({ ok: true, name: '号' + (++n) }) });
        const st = mkColorState([415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;
        for (let i = 1; i <= 12; i++) { hitColorQuota(env, st, 415); await tick(20); }
        ok(env.autoSwitchCalls === 12 && env.run('colorQuotaAttempts') === 12,
            '上限 12：连续 12 次额度都换了号', `${env.autoSwitchCalls}/${env.run('colorQuotaAttempts')}`);
        hitColorQuota(env, st, 415); await tick(40);
        ok(env.autoSwitchCalls === 12, '上限 12：第 13 次不再调用切号', String(env.autoSwitchCalls));
        ok(st.running === false && /已尝试 12 个账号仍无额度/.test(st.pausedReason || ''),
            '上限 12：暂停并提示「已尝试 12 个账号仍无额度」', st.pausedReason);
        ok(env.run('colorQuotaAttempts') === 0 && env.run('colorQuotaTriedAccounts.slice()').length === 0,
            '上限 12：计数与已试列表清零（下一轮重新开始）');
        ok(env.dispatched === 12, '上限 12：只重跑了 12 次', String(env.dispatched));
    }

    // ---- 11) 换色：全都没额度 → 文案带「已试 N 个号」且计数清零 ----
    {
        const seq = [{ ok: true, name: '号A' }, { ok: true, name: '号B' }, { ok: false, reason: 'allExhausted' }];
        let k = 0;
        const env = colorEnv({ autoSwitch: () => seq[Math.min(k++, seq.length - 1)] });
        const st = mkColorState([415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;
        hitColorQuota(env, st, 415); await tick(40);
        hitColorQuota(env, st, 415); await tick(40);
        hitColorQuota(env, st, 415); await tick(60);
        ok(/所有账号额度均已用完（已试 2 个号）/.test(st.pausedReason || ''),
            '全没额度：文案含「已试 2 个号」', st.pausedReason);
        ok(st.running === false, '全没额度：保持暂停');
        ok(env.run('colorQuotaAttempts') === 0 && env.run('colorQuotaTriedAccounts.slice()').length === 0,
            '全没额度：计数与已试列表清零');
        ok(env.run('colorAutoSwitchRunning') === false, '全没额度：防重入 flag 已清');
        ok(env.dispatched === 2, '全没额度：只重跑过 2 次', String(env.dispatched));
    }

    // ---- 12) 套图循环：row3 连续两次额度，换 2 个号后第 3 次成功 ----
    {
        const seq = [{ ok: true, name: '号A' }, { ok: true, name: '号B' }];
        let k = 0;
        const env = suiteEnv({ quotaOnce: { 3: 2 }, autoSwitch: () => seq[Math.min(k++, seq.length - 1)] });
        await env.sandbox.startSuiteGeneration();
        await tick(220);
        const st = env.sandbox.suiteBatchState;
        ok(env.autoSwitchCalls === 2, '套图循环：连续换了 2 个号', String(env.autoSwitchCalls));
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3,3,3,4]',
            '套图循环：row3 原地重跑两次后才前进', JSON.stringify(env.calls.map(c => c.row)));
        const ex = env.reqs.filter(r => r.req && r.req.action === 'doubaoAutoSwitch').map(r => r.req.exclude || []);
        ok(JSON.stringify(ex) === '[[],["号A"]]', '套图循环：第二次换号排除已试过的号A', JSON.stringify(ex));
        ok(st.index === 3 && st.completed === true, '套图循环：整队最终跑完', `${st.index}/${st.completed}`);
        ok(env.sandbox.suiteBatchAttempts === 0 && env.sandbox.suiteBatchTriedAccounts.length === 0,
            '套图循环：批次结束时换号计数清零');
    }

    // ---- 13) 套图上限 12：一直额度 → 换满 12 个号后暂停 ----
    {
        let n = 0;
        const env = suiteEnv({ quotaOnce: { 3: 99 }, autoSwitch: () => ({ ok: true, name: '号' + (++n) }) });
        await env.sandbox.startSuiteGeneration();
        await tick(600);
        const st = env.sandbox.suiteBatchState;
        ok(env.autoSwitchCalls === 12, '套图上限 12：换号 12 次后停手', String(env.autoSwitchCalls));
        ok(st.paused === true && /已尝试 12 个账号仍无额度/.test(st.pausedReason || ''),
            '套图上限 12：暂停并提示试了 12 个号', st.pausedReason);
        ok(st.index === 1, '套图上限 12：index 未前进（仍停在 row3）', String(st.index));
        ok(env.sandbox.suiteBatchRunning === false, '套图上限 12：运行锁已释放');
        ok(env.sandbox.suiteBatchAttempts === 0 && env.sandbox.suiteBatchTriedAccounts.length === 0,
            '套图上限 12：计数清零');
    }

    // ============================================================
    // 扩展侧：doubaoAutoSwitch 只切号 —— 不发任何生成请求
    // ============================================================
    const TEN = ['acct1', 'acct2', 'acct3', 'acct4', 'acct5', 'acct6', 'acct7', 'acct8', 'acct9', 'acct10'];

    // ---- 14) 切号成功立刻返回，且没有发出任何生成/探测请求 ----
    {
        const statuses = { acct1: 'ok' };
        TEN.slice(1).forEach(n => { statuses[n] = 'unknown'; });
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger(statuses) });
        const res = await env.call({ exclude: [] });
        ok(res.ok === true && res.name === 'acct2', '扩展切号：切到候选第一个号 acct2', JSON.stringify(res));
        ok(res.scanned === false, '扩展切号：返回 scanned:false（不做扫描探测）');
        ok(env.switches.length === 1 && env.switches[0] === 'acct2', '扩展切号：只切一次就停', JSON.stringify(env.switches));
        ok(!env.sent.includes('doubaoProbeGenerate'),
            '扩展切号：没有发任何生成请求（无 doubaoProbeGenerate）', env.sent.join(','));
        ok(!env.sent.some(a => /generate|probe/i.test(String(a))),
            '扩展切号：sent 里不含任何 generate/probe 类动作', env.sent.join(','));
        const led = env.ledger();
        ok(led.accounts.acct1.status === 'exhausted' && led.accounts.acct1.note === 'quotaExhausted',
            '扩展切号：当前号记为 exhausted/quotaExhausted（它就是刚弹额度的号）',
            JSON.stringify(led.accounts.acct1));
        ok(led.accounts.acct2.status !== 'exhausted', '扩展切号：切到的新号不会被误判成没额度');
    }

    // ---- 15) 前两个号切不过去 → 记 unknown 后继续，第三个号成功 ----
    {
        const statuses = { acct1: 'ok' };
        TEN.slice(1).forEach(n => { statuses[n] = 'unknown'; });
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger(statuses),
            switchFn: n => (n === 'acct3' ? { ok: true } : { ok: false, error: '切换后用户名不匹配' }) });
        const res = await env.call({ exclude: [] });
        ok(res.ok === true && res.name === 'acct3', '切号失败续试：最终切到 acct3', JSON.stringify(res));
        ok(JSON.stringify(env.switches) === '["acct2","acct3"]', '切号失败续试：按顺序试到成功为止', JSON.stringify(env.switches));
        const led = env.ledger();
        ok(led.accounts.acct2.status === 'unknown' && /用户名不匹配/.test(led.accounts.acct2.note || ''),
            '切号失败续试：失败号记 unknown + note', JSON.stringify(led.accounts.acct2));
        ok(!env.sent.includes('doubaoProbeGenerate'), '切号失败续试：仍不发任何生成请求');
        ok(Array.isArray(res.tried) && res.tried.length === 1 && res.tried[0].name === 'acct2'
            && !!res.tried[0].error, '切号失败续试：tried 里带失败账号与原因', JSON.stringify(res.tried));
    }

    // ---- 16) 所有候选都切不过去 → reason:'none'，tried 覆盖全部候选 ----
    {
        const statuses = { acct1: 'ok' };
        TEN.slice(1).forEach(n => { statuses[n] = 'unknown'; });
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger(statuses),
            switchFn: () => ({ ok: false, error: '页面无返回' }) });
        const res = await env.call({ exclude: [] });
        ok(res.ok === false && res.reason === 'none', '全切不过去：reason=none（结论未知不能报没额度）', JSON.stringify(res));
        ok(res.tried.length === 9, '全切不过去：tried 覆盖 9 个候选', String(res.tried.length));
        ok(/账号都切不过去/.test(res.error || ''), '全切不过去：error 说明原因', res.error);
        ok(env.switches.length === 9, '全切不过去：把候选都试完了才放弃', String(env.switches.length));
        ok(!env.sent.includes('doubaoProbeGenerate'), '全切不过去：不发任何生成请求');
        ok(env.sb.doubaoScanInFlight === false, '全切不过去：重入闸已释放');
    }

    // ---- 16b) 基础设施失败（内容脚本失联）：立刻停手，且不给候选记 unknown ----
    // 真机教训：扩展更新后旧标签注入脚本失效时，7 个候选会全部失败并被逐个记成 unknown，
    // probeSeq/checkedAt 被刷一遍，好号的候选排序被污染。
    {
        const statuses = { acct1: 'ok' };
        TEN.slice(1).forEach(n => { statuses[n] = 'unknown'; });
        const before = { acct2: 2, acct3: 3 };
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger(statuses),
            switchFn: () => ({ ok: false, infra: true, error: '重载后读不到账号列表：内容脚本无响应',
                expect: 'acct2', actualSeq: [] }) });
        const res = await env.call({ exclude: [] });
        ok(res.ok === false && res.reason === 'infra', '失联：reason=infra（不是 none 也不是 allExhausted）', JSON.stringify(res));
        ok(env.switches.length === 1, '失联：只试 1 个号就停手（不把 9 个号全试一遍）', String(env.switches.length));
        const led = env.ledger();
        ok(led.accounts.acct2.probeSeq === before.acct2, '失联：不给好号写 unknown（probeSeq 未变）', String(led.accounts.acct2.probeSeq));
        ok(led.accounts.acct3.probeSeq === before.acct3, '失联：后续候选一个都没被记账', String(led.accounts.acct3.probeSeq));
        ok(env.sb.doubaoScanInFlight === false, '失联：重入闸已释放');
    }

    // ---- 17) 当天全都判过 exhausted → reason:'allExhausted'，一次都不切 ----
    {
        const statuses = {};
        TEN.forEach(n => { statuses[n] = 'exhausted'; });
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger(statuses) });
        const res = await env.call({ exclude: [] });
        ok(res.ok === false && res.reason === 'allExhausted', '全没额度：reason=allExhausted', JSON.stringify(res));
        ok(env.switches.length === 0, '全没额度：一次切号都不发', String(env.switches.length));
        ok(!env.sent.includes('doubaoProbeGenerate'), '全没额度：不发任何生成请求');
    }

    // ---- 18) 页面轮转：第 2 轮调用时排除第 1 轮切过去的号（10 个号，第 3 个有额度）----
    {
        const statuses = { acct1: 'ok' };
        TEN.slice(1).forEach(n => { statuses[n] = 'unknown'; });
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger(statuses) });
        const r1 = await env.call({ exclude: [] });
        ok(r1.ok === true && r1.name === 'acct2', '轮转：第 1 轮切到 acct2', r1.name);
        // 页面在 acct2 上重跑真实任务 → 又弹额度 → 带上已试列表再来一次
        const r2 = await env.call({ exclude: ['acct2'] });
        ok(r2.ok === true && r2.name === 'acct3', '轮转：第 2 轮切到 acct3（不会切回 acct2）', r2.name);
        ok(JSON.stringify(env.switches) === '["acct2","acct3"]', '轮转：没有重复切同一个号', JSON.stringify(env.switches));
        const led = env.ledger();
        ok(led.accounts.acct2.status === 'exhausted', '轮转：acct2 已被记成 exhausted（下轮也不会再选它）');
        const r3 = await env.call({ exclude: ['acct2', 'acct3'] });
        ok(r3.ok === true && r3.name === 'acct4', '轮转：第 3 轮切到 acct4', r3.name);
    }

    // ============================================================
    // 忙态真值表：额度刚被拒 → 忽略 DOM 忙信号（否则额度气泡把换号永久挡住）
    // ============================================================
    const UNIFIED_SEL = '[class*="generating"], [class*="typing"]';

    // ---- 19) 三处忙态选择器是同一个集合，且不含 loading ----
    {
        const contentSel = lit(sliceDecl(DOUBAO_JS, 'DOUBAO_BUSY_SEL'));
        const suiteSel = lit((/const BUSY_SEL = ('[^']*');/.exec(SUITE_DOUBAO_SRC) || [])[1]);
        ok(contentSel === UNIFIED_SEL, `内容脚本忙态选择器 = ${UNIFIED_SEL}`, contentSel);
        ok(suiteSel === UNIFIED_SEL, '套图忙态选择器与内容脚本一致', suiteSel);
        ok(!/loading/.test(contentSel) && !/loading/.test(suiteSel), '忙态集合里没有 loading（避免把懒加载占位判成生成中）');
        const staleLoading = /class\*="loading"\], \[class\*="generating"\]/.test(SUITE_DOUBAO_SRC);
        ok(!staleLoading, '套图里没有残留旧的 loading+generating 组合选择器');
        ok(/sendResponse\(Object\.assign\(\{ ok: true \}, doubaoComputeBusyState\(\)\)\)/.test(DOUBAO_JS),
            'doubaoBusyState 动作返回的就是 doubaoComputeBusyState（没有第二套判定）');
        // 切号守卫必须也用合成忙态，否则前台放行、切号自己再挡回去 = 没修
        const switchSrc = sliceFn(DOUBAO_JS, 'switchDoubaoAccount');
        ok(!/isProcessing \|\| isDoubaoBusyInDom\(\)/.test(switchSrc),
            'switchDoubaoAccount 里没有残留的 "isProcessing || isDoubaoBusyInDom()" 原始判忙');
        ok((switchSrc.match(/doubaoComputeBusyState\(\)\.busy/g) || []).length === 2,
            'switchDoubaoAccount 的两处忙态守卫都走合成忙态（入口 + 点击前）', String((switchSrc.match(/doubaoComputeBusyState\(\)\.busy/g) || []).length));
    }

    // ---- 20) 单点验证：30s 窗口内忽略 DOM；超过 30s 恢复；isProcessing 永远优先 ----
    {
        const e1 = busyEnv({ busyEls: 1 });
        e1.setQuotaAgo(0);
        let st = e1.state();
        ok(st.busy === false && st.quotaRecent === true && st.domBusy === false,
            '额度刚命中（DOM 有 generating）→ busy:false / quotaRecent:true', JSON.stringify(st));

        const e2 = busyEnv({ busyEls: 1 });
        e2.setQuotaAgo(31000);
        st = e2.state();
        ok(st.busy === true && st.domBusy === true && st.quotaRecent === false,
            '超过 30s → 恢复按 DOM 判忙', JSON.stringify(st));

        const e3 = busyEnv({ busyEls: 1 });
        e3.setProcessing(true); e3.setQuotaAgo(0);
        st = e3.state();
        ok(st.busy === true && st.processing === true && st.quotaRecent === true,
            'isProcessing 为真 → 即使 quotaRecent 在 30s 内仍返回 busy（换色在跑不能切号）', JSON.stringify(st));

        const e4 = busyEnv({ busyEls: 0 });
        e4.setQuotaAgo(29000);
        st = e4.state();
        ok(st.busy === false && st.quotaRecent === true, '窗口内且 DOM 不忙 → 依然 free', JSON.stringify(st));

        const e5 = busyEnv({ busyEls: 1 });
        e5.clearQuota();
        st = e5.state();
        ok(st.busy === true && st.quotaRecent === false, '从未额度失败（时间戳 0）→ 照常按 DOM 判忙', JSON.stringify(st));
    }

    // ---- 21) 8 种组合逐一核对：busy = isProcessing || (domBusy && !quotaRecent) ----
    {
        const bad = [];
        for (const p of [false, true]) {
            for (const q of [false, true]) {
                for (const d of [false, true]) {
                    const e = busyEnv({ busyEls: d ? 1 : 0 });
                    e.setProcessing(p);
                    e.setQuotaAgo(q ? 0 : 31000);
                    const s = e.state();
                    const expBusy = p || (d && !q);
                    const expDom = d && !q;
                    if (s.busy !== expBusy || s.domBusy !== expDom || s.processing !== p || s.quotaRecent !== q) {
                        bad.push(`P${+p}Q${+q}D${+d}→${JSON.stringify(s)}`);
                    }
                }
            }
        }
        ok(bad.length === 0, '8 种组合全部符合真值表', bad.join(' '));
    }

    // ---- 22) background 把 quotaRecent 透传出去（页面日志要能区分） ----
    {
        const env = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger({ acct1: 'ok' }),
            busyState: { ok: true, busy: true, processing: false, domBusy: true, quotaRecent: true } });
        const res = await env.call({ exclude: [] });
        ok(res.ok === false && res.reason === 'busy' && res.quotaRecent === true,
            '被忙态挡住时返回 reason:busy + quotaRecent:true', JSON.stringify(res));
        ok(env.switches.length === 0, '被挡住时一次都不切号');

        const env2 = bgEnv({ current: 'acct1', accounts: TEN, ledger: mkLedger({ acct1: 'ok' }),
            busyState: { ok: true, busy: false, processing: false, domBusy: false, quotaRecent: true } });
        const res2 = await env2.call({ exclude: [] });
        ok(res2.ok === true, 'quotaRecent 单独存在（已忽略 DOM）不会把换号挡住', JSON.stringify(res2));
        ok(env2.switches.length === 1, '该场景照常切号');
    }

    console.log(`通过 ${pass}，失败 ${fail}`);
    if (fail) console.log('失败项：' + failures.join(' / '));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
