// ============================================================
// 豆包额度用完 → 整批暂停 验收测试
//   换色：colorTaskComplete 带 quota.exhausted（发品助手.html，真实函数抽取进 vm）
//   套图：自动状态 error 文案含「额度已用完」（suite-batch.js，整文件装载）
// 运行：node tests/test-quota-pause.js
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

const COLOR_FNS = [
    'advanceBatchColorForRow', 'judgeColorTaskResult', 'finishBatchColor', 'resumeColorBatch',
    'computeColorResumeRows', 'refreshColorResumeRowsFromState', 'saveColorBatchState',
    'setColorResumeRows', 'getColorResumeRows', 'setColorTimeoutRows', 'getColorTimeoutRows',
    'stopBatchColorPolling', 'startBatchColorPolling', 'colorBatchFileKey', 'currentFileKey'
];
const COLOR_SRC = [extractConst('COLOR_BATCH_STATE_KEY'), extractConst('COLOR_RESUME_KEY'),
    extractConst('COLOR_TIMEOUT_KEY')]
    .concat(COLOR_FNS.map(extractFn)).join('\n\n');

const OK_RESULTS = (row) => ({
    success: true,
    downloads: ['white', 'black', 'gray', 'navy'].map(c => ({ ok: true, filename: `row${row}_${c}.png` }))
});

function colorEnv(opts = {}) {
    const store = new Map();
    const toasts = [];
    const statuses = [];
    let dispatched = 0;
    let dispatchedRow = null;
    let pollEvent = opts.pollEvent || null;
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
        setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 60)),
        clearInterval: t => clearInterval(t),
        chrome: {
            runtime: {
                lastError: null,
                sendMessage: (id, req, cb) => {
                    if (req && req.action === 'getColorTaskEvents') {
                        const events = {};
                        if (pollEvent) events['color_task_complete_event'] = pollEvent;
                        cb({ ok: true, events });
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
        // 「继续」直接重发当前款（真实 sendNextBatchColor 需要扩展通道，这里只记录派发目标行）
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
    vm.runInContext(COLOR_SRC, ctx, { filename: '发品助手.html:quota-fns' });
    return {
        ctx, store, toasts, statuses,
        get dispatched() { return dispatched; },
        get dispatchedRow() { return dispatchedRow; },
        setPollEvent: e => { pollEvent = e; },
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
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---------- 套图：整文件装载（与 tests/test-suite-batch.js 同风格） ----------
const SUITE_SRC = fs.readFileSync(path.join(__dirname, '..', 'suite-batch.js'), 'utf8');
const STEPS = ['111', '444', '222', '333', '666'];

function suiteEnv(options) {
    const opt = options || {};
    const errorOn = Object.assign({}, opt.errorOn || {});
    const fails = Object.assign({}, opt.fails || {});
    const calls = [], cancels = [], toasts = [], storage = new Map();
    if (opt.seed) storage.set('polo_suite_batch_v1', JSON.stringify(opt.seed));
    const current = { row: 2 };
    const sandbox = {
        localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        products: [{ row: 2 }, { row: 3 }, { row: 4 }], currentProduct: current, currentFileKey: () => 'book',
        showToast: m => toasts.push(m), suiteTaskRunning: false, batchColorState: null, SUITE_STEP_KEYS: STEPS,
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
        cancelSuiteProductTasks: async s => { cancels.push(s.rowNum); },
        renderSuiteAutoControls() {},
        runSuiteFiveJob: async opts => {
            const row = sandbox.currentProduct.row, restart = !!(opts && opts.restart);
            calls.push({ row, restart });
            // 与 runSuiteFiveJob 的 catch 一致：异常被吞，只把 phase:'error' 与 error 文案写进自动状态
            if (errorOn[row]) { sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'error', paused: true, error: errorOn[row] }); return null; }
            if (!restart && fails[row] > 0) { fails[row]--; sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'error', paused: true, error: '上传失败' }); return null; }
            sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: row, phase: 'completed' });
            return null;
        },
        SuiteCore: { ResultStore: () => ({ list: async () => STEPS.map(key => ({ key, blob: { size: 1 } })) }) },
        suiteAutoState: null
    };
    sandbox.window = {};
    vm.createContext(sandbox);
    vm.runInContext(SUITE_SRC, sandbox);
    return { sandbox, calls, cancels, toasts, storage };
}

// ============================================================
(async function main() {
    console.log('豆包额度用完 → 整批暂停');

    // ---- 1) 换色：完成消息带 quota.exhausted → 暂停整批，不记失败、不前进 ----
    {
        const env = colorEnv();
        const st = mkColorState([412, 415, 418], { inFlightRow: 415, currentIndex: 1 });
        env.setState(st); env.ctx.products = st.queue;
        env.run(`advanceBatchColorForRow(415,'message','cb_TEST',${JSON.stringify(OK_RESULTS(415))},`
            + `{exhausted:true,text:'QUOTA_EXHAUSTED：额度已用完（预计 10 月 25 日 03:24 恢复）',resumeAt:'10 月 25 日 03:24'})`);
        ok(st.running === false, '额度用完：running=false（整批暂停）');
        ok(st.stopRequested === true, '额度用完：stopRequested=true');
        ok(/额度/.test(st.pausedReason) && /10 月 25 日 03:24/.test(st.pausedReason),
            '额度用完：pausedReason 含额度与恢复时间', st.pausedReason);
        ok(!(st.failedRows || []).includes(415) && st.failCount === 0, '额度用完：不把本款记进 failedRows');
        ok(st.currentIndex === 1, '额度用完：currentIndex 未前进（仍停在 415）');
        ok(st.successCount === 0 && st.inFlightRow === null, '额度用完：不记成功、清除在途身份');
        ok(env.dispatched === 0, '额度用完：不自动派发下一款');
        ok(env.statuses.some(s => /额度/.test(s)), '额度用完：面板状态栏显示暂停原因');
        ok(env.toasts.some(t => /额度/.test(t) && /已暂停/.test(t)), '额度用完：toast 提示整批暂停');
        ok(env.run('getColorResumeRows().includes(415)'), '额度用完：415 仍在「继续」待办里');
        ok(st.lastAdvancedRow === 415, '额度用完：lastAdvancedRow 已置位（轮询通道自然去重）');

        // 暂停后点「继续」：先重跑额度款 415（即便之前有失败款 412）
        st.failedRows = [412]; st.failCount = 1;
        env.run('resumeColorBatch()');
        ok(st.running === true && st.currentIndex === 1, '继续：从额度款 415 重启（不跳到更早的失败款）');
        ok(env.dispatchedRow === 415, '继续：实际派发的就是 415', String(env.dispatchedRow));
        ok(st.pausedReason === '', '继续：清空暂停原因');
        // 额度暂停后继续必须先换新对话，否则上一轮残留在旧对话里的额度气泡会被当成本轮证据（继续→秒暂停死循环）
        ok(st.freshChatNext === true, '继续：额度暂停置位 freshChatNext（下一款先开新对话）');
    }

    // ---- 2) 换色回归：不带 quota 的普通失败 → 仍「记失败 + 跳款 + 继续」 ----
    {
        const env = colorEnv();
        const st = mkColorState([412, 415], { inFlightRow: 412 });
        env.setState(st); env.ctx.products = st.queue;
        env.run("advanceBatchColorForRow(412,'message','cb_TEST',{downloads:[]})");
        ok((st.failedRows || []).includes(412) && st.failCount === 1, '普通失败：仍记入 failedRows');
        ok(st.currentIndex === 1, '普通失败：仍跳到下一款');
        ok(st.running === true && st.stopRequested === false, '普通失败：不暂停整批');
        ok(env.dispatched === 1, '普通失败：继续派发下一款');
        ok(st.pausedReason === '', '普通失败：不写暂停原因');
    }

    // ---- 2b) 换色：poll 通道带 quota → 同样暂停（两条通道都判） ----
    {
        const env = colorEnv();
        const st = mkColorState([412, 415], { inFlightRow: 415 });
        env.setState(st); env.ctx.products = st.queue;
        env.setPollEvent({
            rowNum: 415, batchId: 'cb_TEST', timestamp: Date.now(), results: OK_RESULTS(415),
            quota: { exhausted: true, text: '额度已用完', resumeAt: '10 月 26 日 01:00' }
        });
        env.run('startBatchColorPolling()');
        await tick(140);
        env.run('stopBatchColorPolling()');
        ok(st.running === false && st.currentIndex === 1, '轮询通道：quota 同样暂停且停在当前款');
        ok(/10 月 26 日 01:00/.test(st.pausedReason), '轮询通道：pausedReason 带恢复时间', st.pausedReason);
        ok(!(st.failedRows || []).includes(415), '轮询通道：不记失败款');
    }

    // ---- 3) 套图：auto 状态 error 含「额度已用完」→ 整批暂停，行不前进、不记失败、不补跑 ----
    {
        const env = suiteEnv({ errorOn: { 3: 'QUOTA_EXHAUSTED：额度已用完（预计 10 月 25 日 03:24 恢复）' } });
        await env.sandbox.startSuiteGeneration();
        const st = env.sandbox.suiteBatchState;
        ok(st.paused === true, '套图额度：paused=true');
        ok(/额度/.test(st.pausedReason || '') && /10 月 25 日 03:24/.test(st.pausedReason || ''),
            '套图额度：pausedReason 含额度与恢复时间', st.pausedReason);
        ok(st.index === 1, '套图额度：index 未前进（仍停在失败行 row3）');
        ok((st.failed || []).length === 0, '套图额度：failed 为空（不记失败）');
        ok(st.retryRound === 0, '套图额度：不进入补跑轮');
        ok(st.completed === false, '套图额度：不标记整批完成');
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3]', '套图额度：暂停后不再跑下一行', JSON.stringify(env.calls));
        ok(env.calls.every(c => c.restart === false), '套图额度：未发起补跑（restart=false）');
        ok(env.cancels.length === 0, '套图额度：不取消该行任务（额度问题不是本行故障）');
        ok(env.toasts.some(t => /额度/.test(t) && /已暂停/.test(t) && /10 月 25 日 03:24/.test(t)),
            '套图额度：toast 含暂停与恢复时间');
        const persisted = JSON.parse(env.storage.get('polo_suite_batch_v1'));
        ok(persisted.paused === true && persisted.index === 1, '套图额度：暂停状态已持久化（同一 storage key）');
    }

    // ---- 4) 套图回归：普通错误 → 仍「记 failed + index++ + 补跑一轮」 ----
    {
        const env = suiteEnv({ fails: { 3: 1 } });
        await env.sandbox.startSuiteGeneration();
        const st = env.sandbox.suiteBatchState;
        ok(JSON.stringify(env.calls.map(c => c.row)) === '[2,3,4,3]', '套图普通错误：跳过继续 + 补跑一次', JSON.stringify(env.calls));
        ok(JSON.stringify(env.calls.map(c => c.restart)) === '[false,false,false,true]', '套图普通错误：补跑用 restart');
        ok(st.index === 3 && st.completed === true, '套图普通错误：index 正常前进并完成');
        ok(st.retryRound === 1 && (st.failed || []).length === 0, '套图普通错误：补跑成功移出 failed');
        ok(st.paused === false, '套图普通错误：不暂停');
        ok(env.cancels.includes(3), '套图普通错误：失败行照旧取消在途任务');
    }

    // ---- 5) 文案归一化：空格/全角逗号/NBSP 都能命中；非额度错误不误判 ----
    {
        const env = suiteEnv();
        env.sandbox.suiteBatchState = { fileKey: 'book', rows: [2, 3], index: 0, paused: false, completed: false, failed: [], retryRound: 0 };
        const hit = text => {
            env.sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: 3, phase: 'error', paused: true, error: text });
            return env.sandbox.suiteBatchQuotaPause(3);
        };
        ok(!!hit('额度 ， 已用完'), '归一化：`额度 ， 已用完` 命中');
        ok(!!hit('额度\u00a0已用完'), '归一化：`额度\\u00a0已用完` 命中');
        ok(!!hit('额度已用完'), '归一化：`额度已用完` 命中');
        ok(!!hit('QUOTA_EXHAUSTED：额度已用完（预计 10 月 25 日 03:24 恢复）'), '归一化：真实错误文案命中');
        ok(hit('上传失败：网络异常') === null, '归一化：普通错误不误判');
        ok(hit('预计 10 月 25 日 03:24 恢复') === null, '归一化：只有恢复时间也不误判');
        // 别的行残留的错误不能暂停当前行
        env.sandbox.saveSuiteAutoState({ fileKey: 'book', rowNum: 4, phase: 'error', paused: true, error: '额度已用完' });
        ok(env.sandbox.suiteBatchQuotaPause(3) === null, '归一化：其它行残留额度错误不误伤当前行');
    }

    // ---- 6) 额度检测基线：文本锚点（真机上节点数会在几秒内 29→1，不能因此漏判） ----
    // 生产逻辑在 chrome_extension/content/doubao.js，suite-doubao.js 是同源副本（本组只校验换色侧，
    // 套图侧同一份逻辑由 tests/manual/quota-probe.js + 真机探针覆盖）。
    {
        const DOUBAO = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension/content/doubao.js'), 'utf8')
            .split('\n').map(l => l.replace(/\r$/, ''));
        function doubaoFn(name) {
            const s = DOUBAO.findIndex(l => new RegExp('^function ' + name + '\\s*\\(').test(l));
            const e = DOUBAO.findIndex((l, i) => i > s && l === '}');
            if (s < 0 || e < 0) throw new Error('未找到函数: ' + name);
            return DOUBAO.slice(s, e + 1).join('\n');
        }
        const page = { nodes: [], noise: {} };
        const mkNode = t => ({ innerText: t, offsetHeight: 20, getClientRects: () => [{}], closest: () => null });
        const doc = {
            querySelectorAll: sel => (sel === 'div[data-message-id]' ? page.nodes.slice() : (page.noise[sel] || [])),
            querySelector: () => null
        };
        const sb = { console: { log() {} }, document: doc };
        vm.createContext(sb);
        vm.runInContext(['var QUOTA_ANCHOR_MAX = 200;', 'var quotaSnapshot = null;',
            'normalizeQuotaText', 'isQuotaExhaustedText', 'parseQuotaResumeAt',
            'collectQuotaMessageNodes', 'lastQuotaMessageText', 'isQuotaExcludedNode',
            'isQuotaVisibleNode', 'collectQuotaNoticeTexts', 'markQuotaBaseline', 'detectQuotaExhausted'
        ].map(x => (x.indexOf('var ') === 0 ? x : doubaoFn(x))).join('\n\n'), sb);
        const mark = () => vm.runInContext('markQuotaBaseline()', sb);
        const detect = () => vm.runInContext('detectQuotaExhausted()', sb);
        const collect = () => vm.runInContext('collectQuotaMessageNodes()', sb);

        const ANCHOR = 'AI：第一轮 5 张图已生成';
        const QUOTA = '额度已用完，预计 10 月 26 日 09:00 恢复';
        for (let i = 1; i <= 29; i++) page.nodes.push(mkNode(i === 29 ? ANCHOR : '历史消息 ' + i));
        const snap = mark();
        ok(snap.count === 29 && snap.lastText === ANCHOR, '锚点基线：快照存的是最后一条消息文本', String(snap.lastText));

        // 渲染抖动：节点数骤降到 2（锚点 + 新增额度气泡）→ 仍必须判出额度
        page.nodes = [mkNode(ANCHOR), mkNode(QUOTA)];
        const hit = detect();
        ok(!!(hit && hit.exhausted), '锚点基线：29→2 仍判出额度（不再因数量变少 null）', JSON.stringify(hit));
        ok(!!(hit && hit.resumeAt === '10月26日09:00'), '锚点基线：resumeAt 解析正确', hit && hit.resumeAt);

        // 锚点原地追加额度文案（豆包把回复写进同一个气泡）→ 命中
        page.nodes = [mkNode('用户：出 5 张图'), mkNode('AI：正在生成…')];
        mark();
        page.nodes[1].innerText = 'AI：正在生成…\n' + QUOTA;
        ok(!!(detect() || {}).exhausted, '锚点基线：锚点节点原地追加额度文案也命中');

        // 锚点被删（真换会话）→ null，宁漏不误
        page.nodes = [mkNode('用户：出 5 张图'), mkNode('AI：正在生成…')];
        mark();
        page.nodes = [mkNode('完全不同的会话'), mkNode('另一个问题')];
        ok(detect() === null, '锚点基线：锚点消失（换会话）→ 不判');

        // 无新增 / 无额度文案 → 不判
        page.nodes = [mkNode(ANCHOR)];
        mark();
        page.nodes = [mkNode(ANCHOR), mkNode('AI：图 1 好了')];
        ok(detect() === null, '锚点基线：只有普通新增消息 → 不判');

        // 选择器：抖动/侧边栏选择器一律不采（数量基线不稳的根因）
        page.nodes = [];
        page.noise = {
            '[class*="message"]': new Array(29).fill(0).map(() => mkNode('x')),
            '[class*="conversation-item"]': new Array(96).fill(0).map(() => mkNode('侧边栏')),
            '[class*="chat-item"]': new Array(96).fill(0).map(() => mkNode('侧边栏'))
        };
        ok(collect().length === 0, '锚点基线：不采 [class*="message"]/chat-item/conversation-item', String(collect().length));
        page.nodes = [mkNode('a'), mkNode('b')];
        ok(collect().length === 2, '锚点基线：优先用 div[data-message-id]');
    }

    console.log(`通过 ${pass}，失败 ${fail}`);
    if (fail) console.log('失败项：' + failures.join(' / '));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
