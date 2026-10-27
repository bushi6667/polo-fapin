// ============================================================
// 连续 3 次生成不出图 → 判定该账号「不支持生图」（今天不再用）→ 换下一个号重跑当前款 验收测试
//   账本：background.js 的 doubaoGenResultAction / doubaoLoadLedger / doubaoBuildCandidates（真实函数抽取进 vm）
//   换色：发品助手.html 的 advanceBatchColorForRow → colorGenFailReport → colorQuotaAutoSwitch（真实函数抽取）
//   套图：suite-batch.js 整文件装载（runSuiteBatch → suiteBatchGenFailGate → suiteBatchTryAutoSwitch）
// 关键约束：只有后台明确回 disabled:true 才换号；普通偶发失败/部分出图一律照旧记失败跳过。
// 运行：node tests/test-account-unsupported.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '发品助手.html'), 'utf8');
const BG = fs.readFileSync(path.join(ROOT, 'chrome_extension', 'background.js'), 'utf8');
const DOUBAO_JS = fs.readFileSync(path.join(ROOT, 'chrome_extension', 'content', 'doubao.js'), 'utf8');
const SUITE_SRC = fs.readFileSync(path.join(ROOT, 'suite-batch.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// ---------- 源码抽取工具（与 tests/test-account-autoswitch.js 同风格） ----------
function sliceFn(src, name) {
    const lines = src.split('\n').map(l => l.replace(/\r$/, ''));
    const startRe = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const s = lines.findIndex(l => startRe.test(l));
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) if (lines[j] === '}') return lines.slice(s, j + 1).join('\n');
    throw new Error('函数未闭合: ' + name);
}
function sliceConst(src, name) {
    const m = new RegExp('^\\s*(?:const|let|var)\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(src);
    if (!m) throw new Error('未找到声明: ' + name);
    return m[0].trim();
}

// ============================================================
// 一、background：账本 + 记账 + 候选（真实函数进 vm）
// ============================================================
const BG_FNS = ['doubaoLocalDateKey', 'doubaoEmptyLedger', 'doubaoNormStatus', 'doubaoLoadLedger',
    'doubaoSaveLedger', 'doubaoReadCurrentName', 'doubaoIsFreshExhausted', 'doubaoProbeOrder',
    'doubaoBuildCandidates', 'doubaoGenResultAction', 'doubaoGenResultSerialized'];
const BG_SRC = ['DOUBAO_LEDGER_KEY', 'DOUBAO_STATUS_OK', 'DOUBAO_STATUS_EXHAUSTED',
    'DOUBAO_STATUS_UNSUPPORTED', 'DOUBAO_STATUS_UNKNOWN', 'DOUBAO_GEN_FAIL_LIMIT', 'DOUBAO_GEN_DEDUPE_MS']
    .map(n => sliceConst(BG, n))
    .concat(['let doubaoGenLastReport = null;', 'let doubaoGenCountedRows = new Set();', 'let doubaoGenQueue = Promise.resolve();'])
    .concat(BG_FNS.map(n => sliceFn(BG, n))).join('\n\n');

function dateKeyNow() {
    const d = new Date(), p = n => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function bgEnv(opts) {
    const o = opts || {};
    const store = new Map();
    if (o.ledger) store.set('polo_doubao_accounts_v1', o.ledger);
    const sb = {
        console: { log() {}, warn() {}, error() {} },
        chrome: {
            storage: {
                local: {
                    get: async k => ({ [k]: store.get(k) }),
                    set: async obj => { Object.keys(obj).forEach(k => store.set(k, obj[k])); }
                }
            }
        },
        findDoubaoTab: async () => ({ id: 7 }),
        // doubaoReadCurrentName 走这里：模拟豆包页当前账号
        doubaoSendToTab: () => Promise.resolve({ ok: true, current: sb.__current }),
        __current: o.current || 'acct1'
    };
    vm.createContext(sb);
    vm.runInContext(BG_SRC, sb, { filename: 'background.js:genresult-fns' });
    return {
        sb, store,
        ledger: () => store.get('polo_doubao_accounts_v1'),
        acct: name => (store.get('polo_doubao_accounts_v1') || {}).accounts[name],
        report: (req, tabId) => sb.doubaoGenResultAction(req, tabId === undefined ? 7 : tabId),
        reportSerialized: (req, tabId) => sb.doubaoGenResultSerialized(req, tabId === undefined ? 7 : tabId),
        load: () => sb.doubaoLoadLedger(),
        candidates: exclude => sb.doubaoBuildCandidates(store.get('polo_doubao_accounts_v1'), exclude),
        setCurrent: n => { sb.__current = n; }
    };
}

// ============================================================
// 二、换色：发品助手.html 的真实函数
// ============================================================
const COLOR_FNS = ['advanceBatchColorForRow', 'judgeColorTaskResult', 'finishBatchColor', 'resumeColorBatch',
    'computeColorResumeRows', 'refreshColorResumeRowsFromState', 'saveColorBatchState',
    'setColorResumeRows', 'getColorResumeRows', 'setColorTimeoutRows', 'getColorTimeoutRows',
    'stopBatchColorPolling', 'startBatchColorPolling', 'colorBatchFileKey', 'currentFileKey',
    'doubaoAccountMessage', 'colorGenFailReport', 'colorQuotaAutoSwitch', 'applyColorAutoSwitch',
    'restartColorBatchForRow'];
const COLOR_SRC = ['COLOR_BATCH_STATE_KEY', 'COLOR_RESUME_KEY', 'COLOR_TIMEOUT_KEY',
    'colorAutoSwitchRunning', 'colorQuotaTriedAccounts', 'colorQuotaAttempts', 'COLOR_QUOTA_SWITCH_LIMIT']
    .map(n => sliceConst(HTML, n))
    .concat(COLOR_FNS.map(n => sliceFn(HTML, n))).join('\n\n');

// 生成不出图（0 图）：内容脚本回传的就是这种结果
const GEN_FAIL_RESULTS = row => ({ success: false, error: '豆包生成失败：出了点问题，请稍后重试', downloads: [] });
// 部分出图（3/4 色）：任务不完整，但账号能生图 —— 不能被判成「不支持生图」
const PARTIAL_RESULTS = row => ({
    success: true,
    downloads: ['white', 'black', 'gray'].map(c => ({ ok: true, filename: `row${row}_${c}.png` }))
});

function colorEnv(opts) {
    const o = opts || {};
    const store = new Map();
    const toasts = [];
    const statuses = [];
    const reqs = [];
    let dispatched = 0, dispatchedRow = null, autoSwitchCalls = 0, genResultCalls = 0;
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
        setInterval: () => 0,
        clearInterval: () => {},
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: (id, req, cb) => {
                    reqs.push({ id, req });
                    if (req && req.action === 'doubaoGenResult') {
                        genResultCalls++;
                        const res = typeof o.genResult === 'function'
                            ? o.genResult(req)
                            : (o.genResult || { ok: true, name: '号A', streak: 1, disabled: false });
                        if (cb) cb(res);
                        return;
                    }
                    if (req && req.action === 'doubaoAutoSwitch') {
                        autoSwitchCalls++;
                        const res = typeof o.autoSwitch === 'function'
                            ? o.autoSwitch(req)
                            : (o.autoSwitch || { ok: true, name: '号B' });
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
    vm.runInContext(COLOR_SRC, ctx, { filename: '发品助手.html:unsupported-fns' });
    return {
        ctx, store, toasts, statuses, reqs,
        get dispatched() { return dispatched; },
        get dispatchedRow() { return dispatchedRow; },
        get autoSwitchCalls() { return autoSwitchCalls; },
        get genResultCalls() { return genResultCalls; },
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
        label: '批量换色', failedRows: [], lastMemMB: 0,
        batchId: 'cb_TEST', executionId: null,
        inFlightRow: opts.inFlightRow !== undefined ? opts.inFlightRow : rows[0],
        inFlightSince: Date.now(), pendingAckRow: null, timedOutRows: [],
        freshChatNext: false, supplementDone: false, pausedReason: ''
    };
}

// ============================================================
// 三、套图：suite-batch.js 整文件装载
// ============================================================
const STEPS = ['111', '444', '222', '333', '666'];
const QUOTA_TEXT = 'QUOTA_EXHAUSTED：额度已用完（预计 10 月 25 日 03:24 恢复）';

function suiteEnv(options) {
    const opt = options || {};
    const quotaOnce = Object.assign({}, opt.quotaOnce || {});
    const genFailOnce = Object.assign({}, opt.genFailOnce || {});
    const calls = [], toasts = [], storage = new Map(), reqs = [], logs = [];
    let autoSwitchCalls = 0, genResultCalls = 0;
    const current = { row: 2 };
    const sandbox = {
        console: {
            log: m => logs.push(String(m)),
            warn: m => logs.push(String(m)),
            error() {}
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: t => clearTimeout(t),
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: (id, req, cb) => {
                    reqs.push({ id, req });
                    if (req && req.action === 'doubaoGenResult') {
                        genResultCalls++;
                        const res = typeof opt.genResult === 'function'
                            ? opt.genResult(req)
                            : (opt.genResult || { ok: true, name: '号A', streak: 1, disabled: false });
                        if (cb) cb(res);
                        return;
                    }
                    if (req && req.action === 'doubaoAutoSwitch') {
                        autoSwitchCalls++;
                        const res = typeof opt.autoSwitch === 'function'
                            ? opt.autoSwitch(req)
                            : (opt.autoSwitch || { ok: true, name: '号B' });
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
        showToast: m => toasts.push(m),
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
        runSuiteFiveJob: async opts2 => {
            const row = sandbox.currentProduct.row, restart = !!(opts2 && opts2.restart);
            calls.push({ row, restart });
            if (!restart && quotaOnce[row] > 0) {
                quotaOnce[row]--;
                sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'error', paused: true, error: QUOTA_TEXT });
                return null;
            }
            if (!restart && genFailOnce[row] > 0) {
                genFailOnce[row]--;
                sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'error', paused: true, error: '生成失败：出了点问题，请稍后重试' });
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
    return { sandbox, calls, toasts, storage, reqs, logs,
        get autoSwitchCalls() { return autoSwitchCalls; },
        get genResultCalls() { return genResultCalls; } };
}

// ============================================================
(async function main() {
    console.log('连续 3 次生成不出图 → 判该账号不支持生图 → 换号重跑');

    // ---- 1) 连续 3 次 ok:false：前两次不 disabled（streak 1/2），第 3 次 disabled + 账本 unsupported ----
    {
        const env = bgEnv({ current: 'acct1' });
        const r1 = await env.report({ ok: false, row: 2, reason: '等图超时/0 图' });
        ok(r1.ok === true && r1.streak === 1 && r1.disabled === false, '第 1 次失败：streak=1、不 disabled', JSON.stringify(r1));
        ok(r1.reasonKind === 'genFail', '第 1 次失败：reasonKind=genFail（还没到「不支持生图」）', r1.reasonKind);
        ok(env.acct('acct1').status === 'unknown' && env.acct('acct1').genFailStreak === 1,
            '第 1 次失败：账本仍是 unknown，只累加 streak', JSON.stringify(env.acct('acct1')));

        const r2 = await env.report({ ok: false, row: 3, reason: '等图超时/0 图' });
        ok(r2.streak === 2 && r2.disabled === false, '第 2 次失败：streak=2、仍不 disabled', JSON.stringify(r2));
        ok(env.acct('acct1').unsupportedAt === 0, '第 2 次失败：还没被判不支持生图');

        const r3 = await env.report({ ok: false, row: 4, reason: '等图超时/0 图' });
        ok(r3.streak === 3 && r3.disabled === true, '第 3 次失败：disabled=true', JSON.stringify(r3));
        const a = env.acct('acct1');
        ok(a.status === 'unsupported', '第 3 次失败：账本 status=unsupported', a.status);
        ok(a.note === 'genFailed3', '第 3 次失败：note=genFailed3（能看出是不支持生图而不是额度）', a.note);
        ok(a.unsupportedAt > 0 && a.genFailAt > 0, '第 3 次失败：unsupportedAt / genFailAt 已落盘', JSON.stringify(a));
        ok(r3.reasonKind === 'unsupported', '返回里带 reasonKind=unsupported（与额度原因区分）', r3.reasonKind);
    }

    // ---- 2) 中间成功一次 → streak 归零，之后重新从 1 开始 ----
    {
        const env = bgEnv({ current: 'acct1' });
        await env.report({ ok: false, row: 2 });
        await env.report({ ok: false, row: 3 });
        ok(env.acct('acct1').genFailStreak === 2, '成功中断前：streak=2');
        const okRes = await env.report({ ok: true, row: 4 });
        ok(okRes.streak === 0 && env.acct('acct1').genFailStreak === 0 && env.acct('acct1').genFailAt === 0,
            '出图一次：streak 与 genFailAt 归零', JSON.stringify(env.acct('acct1')));
        const again = await env.report({ ok: false, row: 5 });
        ok(again.streak === 1 && again.disabled === false, '再失败：重新从 1 开始（不是接着数 3）', JSON.stringify(again));
    }

    // ---- 3) 同一次失败被内容脚本 + 页面各报一次：只算一次（否则阈值会被砍成 1.5 次）----
    {
        const env = bgEnv({ current: 'acct1' });
        const a1 = await env.report({ ok: false, row: 7, reason: '0 图' });   // 内容脚本上报
        const a2 = await env.report({ ok: false, row: 7, reason: '0 图' });   // 页面紧接着问结论
        ok(a1.streak === 1 && a2.streak === 1 && a2.deduped === true,
            '同一行 8 秒内双上报：只记一次，页面拿到同一结论', JSON.stringify([a1, a2]));
        const a3 = await env.report({ ok: false, row: 8, reason: '0 图' });
        ok(a3.streak === 2, '换一行再失败：正常累加到 2', JSON.stringify(a3));

        // 真并发：内容脚本与页面的两条上报同时在途（读改写会各加一次）→ 串行闸保证只算一次
        const [c1, c2] = await Promise.all([
            env.reportSerialized({ ok: false, row: 9, reason: '0 图' }),
            env.reportSerialized({ ok: false, row: 9, reason: '0 图' })
        ]);
        ok(c1.streak === 3 && c2.streak === 3 && env.acct('acct1').genFailStreak === 3,
            '并发双上报（串行闸）：只 +1 次 streak=3，不会跳成 4', JSON.stringify([c1.streak, c2.streak]));
    }

    // ---- 4) unsupported 账号不再是候选（exhausted 与 unsupported 分开返回原因）----
    {
        const env = bgEnv({ current: 'acct1' });
        for (const row of [2, 3, 4]) await env.report({ ok: false, row });
        // 另一个号今天弹过额度
        env.setCurrent('acct2');
        const led = env.ledger();
        led.accounts.acct2 = { plan: '', status: 'exhausted', percent: null, label: '', checkedAt: Date.now(),
            note: 'quotaExhausted', resumeAt: '', missing: false, probeSeq: 2 };
        led.accounts.acct3 = { plan: '', status: 'unknown', percent: null, label: '', checkedAt: 0,
            note: '', resumeAt: '', missing: false, probeSeq: 3 };
        const cand = env.candidates([]);
        ok(JSON.stringify(cand.order) === '["acct3"]', '候选只剩 unknown 的 acct3', JSON.stringify(cand.order));
        ok(cand.skippedUnsupported.indexOf('acct1') >= 0 && cand.skipped.indexOf('acct1') >= 0,
            'unsupported 的 acct1 被跳过（skippedUnsupported 里能看出原因）', JSON.stringify(cand.skippedUnsupported));
        ok(cand.skippedExhausted.indexOf('acct2') >= 0 && cand.skippedUnsupported.indexOf('acct2') < 0,
            'exhausted 的 acct2 归到 skippedExhausted（两种原因分得开）', JSON.stringify(cand.skippedExhausted));
    }

    // ---- 5) 跨天：dateKey 变化后 unsupported 变回 unknown，streak 一起清零 ----
    {
        const env = bgEnv({
            current: 'acct1',
            ledger: {
                dateKey: '2020-01-01', updatedAt: 1, accounts: {
                    acct1: { plan: '', status: 'unsupported', percent: null, label: '', checkedAt: Date.now(),
                        note: 'genFailed3', resumeAt: '', missing: false, probeSeq: 1,
                        genFailStreak: 3, genFailAt: Date.now(), unsupportedAt: Date.now() }
                }
            }
        });
        const led = await env.load();
        const a = led.accounts.acct1;
        ok(a.status === 'unknown', '跨天重置：unsupported → unknown', a.status);
        ok(a.genFailStreak === 0 && a.unsupportedAt === 0 && a.genFailAt === 0,
            '跨天重置：genFailStreak / unsupportedAt / genFailAt 全部清零', JSON.stringify(a));
        ok(a.note === 'dayRefresh', '跨天重置：note=dayRefresh', a.note);
        ok(led.dateKey === dateKeyNow(), '跨天重置：dateKey 更新为今天', led.dateKey);
    }

    // ---- 6) 成功一次可以把 unsupported 恢复成 unknown ----
    {
        const env = bgEnv({ current: 'acct1' });
        for (const row of [2, 3, 4]) await env.report({ ok: false, row });
        ok(env.acct('acct1').status === 'unsupported', '前置：acct1 已判 unsupported');
        const res = await env.report({ ok: true, row: 5 });
        ok(res.disabled === false && res.recovered === true, '出图成功：返回 recovered=true、disabled=false', JSON.stringify(res));
        const a = env.acct('acct1');
        ok(a.status === 'unknown' && a.note === 'genOkRecovered' && a.unsupportedAt === 0,
            '出图成功：恢复 unknown、unsupportedAt 清零', JSON.stringify(a));
    }

    // ---- 7) 换色：generationFailed + disabled:true → 换号 + 重跑本款 + 不记失败 ----
    {
        const env = colorEnv({ genResult: { ok: true, name: '号A', streak: 3, disabled: true } });
        const st = mkColorState([412, 415, 418], { inFlightRow: 415, currentIndex: 1 });
        const oldBatchId = st.batchId;
        env.setState(st); env.ctx.products = st.queue;

        env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(GEN_FAIL_RESULTS(415))})`);
        ok(env.genResultCalls === 1, '换色 0 图：先向后台报了一次 doubaoGenResult', String(env.genResultCalls));
        const rep = env.reqs.find(r => r.req && r.req.action === 'doubaoGenResult');
        ok(rep && rep.req.ok === false && Number(rep.req.row) === 415 && !!rep.req.reason,
            '上报内容：ok:false + row + reason', JSON.stringify(rep && rep.req));
        ok(env.autoSwitchCalls === 0 && st.running === true, '等后台结论期间：不立刻判失败、批次不动');
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '等结论期间：还没记失败');

        await tick(60);
        ok(env.autoSwitchCalls === 1, 'disabled:true → 复用 doubaoAutoSwitch 换号一次', String(env.autoSwitchCalls));
        ok(st.running === true && st.stopRequested === false, '换号成功后批次继续（running=true）');
        ok(st.batchId !== oldBatchId && /^bc_/.test(st.batchId), '换号成功：换新 batchId', st.batchId);
        ok(st.currentIndex === 1 && env.dispatched === 1 && env.dispatchedRow === 415,
            '换号成功：原地重跑当前款 415（不前进）', `${st.currentIndex}/${env.dispatchedRow}`);
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '换号成功：本款不进 failedRows');
        ok(env.toasts.some(t => /已连续 3 次生成失败/.test(t) && /判定该账号不支持生图/.test(t) && /正在换号/.test(t)),
            '日志/提示含「已连续 3 次生成失败，判定该账号不支持生图，正在换号…」', env.toasts.join(' | '));
        ok(env.toasts.some(t => /已切到 号B/.test(t)), '换到新号后提示重跑', env.toasts.join(' | '));
        ok(!env.toasts.some(t => /额度/.test(t)), '这一刻的提示里不出现「额度」（原因要能区分）', env.toasts.join(' | '));
        ok(env.run('colorQuotaAttempts') === 1 && env.run('colorQuotaTriedAccounts.slice()').join(',') === '号B',
            '换号计数/已试列表共用额度那套（attempts=1、已试=号B）',
            `${env.run('colorQuotaAttempts')}/${env.run('colorQuotaTriedAccounts.slice()')}`);
        ok(env.run('colorAutoSwitchRunning') === false, '换号结束：防重入 flag 已清');
    }

    // ---- 8) 换色：generationFailed + disabled:false → 记失败跳款，绝不换号 ----
    {
        const env = colorEnv({ genResult: { ok: true, name: '号A', streak: 1, disabled: false } });
        const st = mkColorState([412, 415], { inFlightRow: 412 });
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(412,'message','cb_TEST',${JSON.stringify(GEN_FAIL_RESULTS(412))})`);
        await tick(60);
        ok(env.genResultCalls === 1, 'disabled:false：只上报、不换号（上报 1 次）', String(env.genResultCalls));
        ok(env.autoSwitchCalls === 0, 'disabled:false：不触发 doubaoAutoSwitch', String(env.autoSwitchCalls));
        ok((st.failedRows || []).includes(412) && st.failCount === 1, 'disabled:false：照原逻辑记失败');
        ok(st.currentIndex === 1, 'disabled:false：跳到下一款', String(st.currentIndex));
        ok(st.running === true && st.pausedReason === '', 'disabled:false：不暂停整批');
        ok(env.dispatched === 1, 'disabled:false：继续派发下一款（processNextBatchColor 被调用一次）', String(env.dispatched));
        ok(!env.toasts.some(t => /不支持生图/.test(t)), 'disabled:false：提示里不出现「不支持生图」', env.toasts.join(' | '));
    }

    // ---- 9) 换色：部分出图（3/4 色）→ 连上报都不做（账号明明能生图）----
    {
        const env = colorEnv({ genResult: { ok: true, name: '号A', streak: 3, disabled: true } });
        const st = mkColorState([412], { inFlightRow: 412 });
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(412,'message','cb_TEST',${JSON.stringify(PARTIAL_RESULTS(412))})`);
        await tick(60);
        ok(env.genResultCalls === 0, '部分出图：不报生成失败（能出图就不算不支持生图）', String(env.genResultCalls));
        ok(env.autoSwitchCalls === 0, '部分出图：不换号');
        ok((st.failedRows || []).includes(412) && st.currentIndex === 1, '部分出图：按原逻辑记失败并跳款');
    }

    // ---- 10) 换色：记账通道异常 → 不换号、不卡死，照原逻辑记失败 ----
    {
        const env = colorEnv({ genResult: () => { throw new Error('Extension context invalidated'); } });
        const st = mkColorState([412, 415], { inFlightRow: 412 });
        env.setState(st); env.ctx.products = st.queue;
        let crashed = null;
        try {
            env.run(`advanceBatchColorForRow(412,'message','cb_TEST',${JSON.stringify(GEN_FAIL_RESULTS(412))})`);
        } catch (e) { crashed = e; }
        await tick(60);
        ok(crashed === null, '记账异常：同步调用不抛出', crashed && crashed.message);
        ok(env.autoSwitchCalls === 0, '记账异常：不换号');
        ok((st.failedRows || []).includes(412) && st.currentIndex === 1, '记账异常：照原逻辑记失败并跳款');
    }

    // ---- 11) 套图：失败且 disabled:true → 换号 + 原地重跑该行 + 不记失败 ----
    {
        const env = suiteEnv({ genFailOnce: { 3: 1 }, genResult: { ok: true, name: '号A', streak: 3, disabled: true } });
        await env.sandbox.startSuiteGeneration();
        await tick(200);
        const st = env.sandbox.suiteBatchState;
        ok(env.genResultCalls >= 1, '套图：失败行上报了 doubaoGenResult', String(env.genResultCalls));
        const rep = env.reqs.find(r => r.req && r.req.action === 'doubaoGenResult' && r.req.ok === false);
        ok(rep && Number(rep.req.row) === 3, '套图上报内容：ok:false + row3', JSON.stringify(rep && rep.req));
        ok(env.autoSwitchCalls === 1, '套图 disabled:true → 换号 1 次', String(env.autoSwitchCalls));
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3,3,4]',
            '套图：row3 原地重跑而不是跳过', JSON.stringify(env.calls.map(c => c.row)));
        ok((st.failed || []).length === 0, '套图：失败行不登记（换号重跑成功）', JSON.stringify(st.failed));
        ok(st.index === 3 && st.completed === true, '套图：整队跑完', `${st.index}/${st.completed}`);
        ok(env.toasts.some(t => /判定该账号不支持生图/.test(t) && /正在换号/.test(t)),
            '套图提示含「判定该账号不支持生图，正在换号…」', env.toasts.join(' | '));
        ok(env.toasts.some(t => /已切到 号B/.test(t) && /重跑第 3 行/.test(t)), '套图换号后提示重跑该行', env.toasts.join(' | '));
        ok(env.logs.some(l => /第 1 次换号（不支持生图）/.test(l)), '套图换号日志标注（不支持生图）', env.logs.join(' | '));
        ok(env.sandbox.suiteBatchAttempts === 0 && env.sandbox.suiteBatchTriedAccounts.length === 0,
            '套图批次结束：换号计数清零');
    }

    // ---- 12) 套图：失败且 disabled:false → 记失败跳过（不换号）----
    {
        const env = suiteEnv({ genFailOnce: { 3: 1 }, genResult: { ok: true, name: '号A', streak: 1, disabled: false } });
        await env.sandbox.startSuiteGeneration();
        await tick(200);
        const st = env.sandbox.suiteBatchState;
        ok(env.genResultCalls >= 1, '套图 disabled:false：仍会上报（计数靠它）', String(env.genResultCalls));
        ok(env.autoSwitchCalls === 0, '套图 disabled:false：不换号', String(env.autoSwitchCalls));
        ok(st.retryRound === 1, '套图 disabled:false：row3 第一轮被记为失败（因此进了补跑轮）', String(st.retryRound));
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3,4,3]',
            '套图：跳过后补跑轮重启 row3（原逻辑不变）', JSON.stringify(env.calls.map(c => c.row)));
        ok(st.completed === true, '套图：队列最终跑完');
        ok(!env.toasts.some(t => /不支持生图/.test(t)), '套图 disabled:false：提示里不出现「不支持生图」', env.toasts.join(' | '));
    }

    // ---- 13) 套图：额度失败不记成生成失败（两条机制不串）----
    {
        const env = suiteEnv({ quotaOnce: { 3: 1 }, genResult: { ok: true, name: '号A', streak: 3, disabled: true } });
        await env.sandbox.startSuiteGeneration();
        await tick(200);
        const genFailReports = env.reqs.filter(r => r.req && r.req.action === 'doubaoGenResult' && r.req.ok === false);
        ok(genFailReports.length === 0, '套图额度命中：不上报生成失败', JSON.stringify(genFailReports.map(r => r.req)));
        ok(env.autoSwitchCalls === 1, '套图额度命中：仍走原来的额度换号', String(env.autoSwitchCalls));
    }

    // ---- 14) 内容脚本：只有「非额度」才上报；额度命中走独立机制 ----
    {
        const quotaBranch = /if \(!quota\) \{[\s\S]{0,900}?action: 'doubaoGenResult'/.test(DOUBAO_JS);
        ok(quotaBranch, 'doubao.js：doubaoGenResult 上报被 !quota 包住（额度命中不记生成失败）');
        ok(/const gotImage = \(results\.downloads \|\| \[\]\)\.length > 0/.test(DOUBAO_JS),
            'doubao.js：出图判定按「拿到任意一张」，不按落盘是否全部成功');
        ok(!/some\(d => d && d\.ok === true\)/.test(DOUBAO_JS),
            'doubao.js：不再用 d.ok（落盘成功）当生成判据');
        ok(/platformError = \/出了点问题\|请稍后重试\|网络\|超时\|timeout\/i/.test(DOUBAO_JS),
            'doubao.js：平台自身报错/超时只打日志，不计账号失败');
        ok(/if \(!gotImage && platformError\)/.test(DOUBAO_JS),
            'doubao.js：只有「一张没拿到 + 非平台报错」才上报 ok:false');
        ok(/\.catch\(err => log\('生成结果记账失败/.test(DOUBAO_JS),
            'doubao.js：上报是 fire-and-forget，失败只打 warn 日志');
        ok(!/await chrome\.runtime\.sendMessage\(\{\s*action: 'doubaoGenResult'/.test(DOUBAO_JS),
            'doubao.js：上报没有 await（不阻塞主流程）');
    }

    // ---- 15) 来源校验：外部通道（发品助手页）不能用 sender.tab 当豆包页 ----
    // 助手页是普通网页，sender.tab 是它自己的 tab，拿去找「当前账号名」永远读不到，
    // 结果就是 disabled 恒为 false、连续 3 次失败也不换号（V4 复核发现的 P1）。
    {
        const at = BG.indexOf("if (request.action === 'doubaoGenResult')");
        const nextAt = BG.indexOf('if (request.action ===', at + 10);
        const branch = at >= 0 ? BG.slice(at, nextAt > at ? nextAt : at + 1500) : '';
        ok(!!branch, 'background：能定位到外部通道的 doubaoGenResult 分支');
        ok(/fromDoubaoTab/.test(branch), 'background：外部通道校验来源是否豆包 tab');
        ok(/doubao\\\.com/.test(branch), 'background：来源校验用的是豆包域名正则');
        ok(/fromDoubaoTab \? sender\.tab\.id : 0/.test(branch),
            'background：非豆包来源一律传 0（由 findDoubaoTab 兜底）');
    }

    // ---- 16) 按行去重 + 滚动 + 部分图不丢弃 + 二次超时恢复记账 ----
    {
        // 16a 同一行的失败终身只记一次（双报/重试/补跑都不会重复计数）
        {
            const env = bgEnv({});
            await env.report({ ok: false, row: 9, reason: '超时未出图' });
            const before = env.acct('acct1').genFailStreak;
            const r2 = await env.report({ ok: false, row: 9, reason: '超时未出图' });
            ok(before === 1 && env.acct('acct1').genFailStreak === 1 && r2.deduped === true,
                '同一行第二次失败被按行去重（streak 不重复累计）');
            const r3 = await env.report({ ok: false, row: 10, reason: '超时未出图' });
            ok(r3.deduped === false && env.acct('acct1').genFailStreak === 2,
                '不同行照常累计');
        }
        // 16b 行号缺失时退回 8 秒窗口（不能把不同失败互相当重复）
        {
            const env = bgEnv({});
            await env.report({ ok: false, row: 0, reason: 'a' });
            const r2 = await env.report({ ok: false, row: 0, reason: 'b' });
            // 立即双报在 8 秒窗口内本来就该去重（这正是窗口的用途）；
            // 终身去重只对 row>0 生效，用源码判据锁死，防止以后把 row=0 也改成终身去重。
            ok(env.acct('acct1').genFailStreak === 1 && r2.deduped === true,
                'row=0 立即双报仍被 8 秒窗口去重（窗口用途不变）');
            ok(/const rowKey = row > 0 \? \(name \+ '\\0' \+ row\) : ''/.test(BG),
                'row=0 不进终身去重（源码判据）');
        }
        // 16c 换色等图循环：滚动 + 部分图保留 + 二次超时上报（源码断言）
        ok(/image\.scrollIntoView\(\{ block: 'center', behavior: 'instant' \}\)/.test(DOUBAO_JS)
            && /startsWith\('data:image\/svg'\)/.test(DOUBAO_JS),
            'doubao.js：等图循环把 SVG 占位图滚进视口（与套图同做法）');
        ok(/allNewUrls = newUrls\.slice\(0, totalImages\);\s*\n\s*log\(`\[\$\{elapsed\}s\] 图片增加/.test(DOUBAO_JS),
            'doubao.js：图片增加时就保留部分结果（超时不再当 0 张丢）');
        ok(/只等到 \$\{allNewUrls\.length\}\/\$\{totalImages\} 张，按已有部分继续下载/.test(DOUBAO_JS),
            'doubao.js：部分图有自己的日志（不再冒充"未检测到足够新图"）');
        const retryBranch = HTML.slice(HTML.indexOf('function setupBatchColorTimeout'), HTML.indexOf('function checkAllColorsReady'));
        ok(/colorGenFailReport\(product\.row, '超时未出图（重试 1 次后仍无图）', 'timeout', skipRow\)/.test(retryBranch),
            '发品助手.html：二次超时恢复上报账号失败（连续 3 次换号的口径）');
    }

    console.log(`通过 ${pass}，失败 ${fail}`);
    if (fail) console.log('失败项：' + failures.join(' / '));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
