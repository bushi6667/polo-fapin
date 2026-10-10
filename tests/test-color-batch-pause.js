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
    const lines = HTML.split('\n');
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
    'computeColorResumeRows', 'refreshColorResumeRowsFromState', 'advanceBatchColorForRow',
    'setColorResumeRows', 'getColorResumeRows', 'finishBatchColor', 'resumeColorBatch'
];
const SRC = FN_NAMES.map(extractFn).join('\n\n');

// ---------- 环境 ----------
function createEnv(opts = {}) {
    const store = new Map();
    const toasts = [];
    const log = [];
    let dispatched = 0;
    let beginCalls = 0;
    const timers = [];

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
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; },
        clearInterval: (t) => clearInterval(t),
        // UI / 依赖 mock
        showToast: (m) => toasts.push(m),
        updateBatchColorProgress: () => {},
        loadColorImagesFromExtension: () => {},
        syncColorResumeButton: () => {},
        restoreBatchColorUI: () => {},
        stopBatchColorPolling: () => {},
        updateBatchColorStatus: () => {},
        updateBatchColorFill: () => {},
        setBatchColorToggle: () => {},
        processNextBatchColor: () => { dispatched++; },
        beginColorBatch: () => { beginCalls++; },
        buildRowPreviewLines: () => ['preview'],
        confirm: () => (opts.confirmReject ? false : true),
        COLOR_RESUME_KEY: 'polo_color_resume_rows',
        colorPollTimer: null,
        psPollTimer: null,
        products: [],
        extensionInstalled: true,
        // 全局状态（每个用例自行设置）
        batchColorState: null
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    // 先声明全局变量，再执行函数源码（函数内会读写 batchColorState）
    vm.runInContext('var batchColorState = null;', ctx);
    vm.runInContext(SRC, ctx, { filename: '发品助手.html:color-fns' });

    return {
        ctx,
        store, toasts, log,
        get dispatched() { return dispatched; },
        get beginCalls() { return beginCalls; },
        run: (expr) => vm.runInContext(expr, ctx),
        clearTimers: () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } },
        // 构造一个"已派发 row1，正在生成"的暂停态
        setState: (s) => { sandbox.batchColorState = s; vm.runInContext('batchColorState = __s;', Object.assign(ctx, { __s: s })); }
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
        pausedReason: ''
    };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ============================================================
(async function main() {
    console.log('=== 换色：资源暂停后在途款完成 验收测试 ===');
    console.log('（函数源码从 发品助手.html 抽取，非复制实现）\n');

    // ---------- 1. 资源暂停后，在途款完成必须入账 ----------
    console.log('【1】资源不足暂停 → 当前款随后完成 → 计入成功，且不再出现在「继续」列表');
    {
        const env = createEnv();
        const st = mkState([412, 415], { inFlightRow: 412 });
        env.setState(st);
        env.run(`finishBatchColor(false, '提交剩余 120MiB < 4096MiB')`);
        ok(st.running === false, '已暂停（running=false）');
        ok(st.pausedReason.includes('提交剩余'), `记录资源暂停原因（${st.pausedReason}）`);
        const resumeAtPause = env.run('getColorResumeRows()');
        ok(resumeAtPause.join(',') === '415', `暂停时「继续」列表不含在途款（实际 ${resumeAtPause.join(',')}）`);

        const before = env.dispatched;
        env.run(`advanceBatchColorForRow(412, 'message', 'cb_TEST')`);
        ok(st.successCount === 1, `在途款完成计入成功数（实际 ${st.successCount}）`);
        ok(st.currentIndex === 1, `当前索引推进（实际 ${st.currentIndex}）`);
        ok(st.inFlightRow === null, '在途行已清空');
        ok(env.dispatched === before, `暂停中完成未自动派发下一款（dispatch ${env.dispatched - before}）`);
        const resumeAfter = env.run('getColorResumeRows()');
        ok(resumeAfter.join(',') === '415', `完成行未进入「继续」列表（实际 ${resumeAfter.join(',')}）`);
        env.clearTimers();
    }

    // ---------- 2. 手动停止后完成同样入账 ----------
    console.log('\n【2】手动停止（stopRequested）→ 当前款完成 → 计入成功，不自动派发');
    {
        const env = createEnv();
        const st = mkState([501, 502], { running: false, stopRequested: true, inFlightRow: 501 });
        env.setState(st);
        env.run('setColorResumeRows([501, 502])');
        const before = env.dispatched;
        env.run(`advanceBatchColorForRow(501, 'message', 'cb_TEST')`);
        ok(st.successCount === 1, `计入成功（实际 ${st.successCount}）`);
        ok(env.dispatched === before, '未自动派发下一款');
        const resume = env.run('getColorResumeRows()');
        ok(resume.indexOf(501) < 0, `已完成行不在「继续」列表（实际 ${resume.join(',')}）`);
        env.clearTimers();
    }

    // ---------- 3. 在途款仍在生成时，点「继续」必须拒绝 ----------
    console.log('\n【3】当前款仍在生成中 → 「继续」被拒绝（不重复提交该款）');
    {
        const env = createEnv();
        const st = mkState([601, 602, 603], { running: false, inFlightRow: 601 });
        env.setState(st);
        env.run('setColorResumeRows([602, 603])');
        env.run('products = [{row:601},{row:602},{row:603}]');
        env.run('resumeColorBatch()');
        ok(env.beginCalls === 0, `未启动新任务（beginColorBatch 调用 ${env.beginCalls} 次）`);
        ok(env.toasts.some(t => /仍在豆包生成中/.test(t)), `提示等待当前款结束（${env.toasts.join(' | ')}）`);
        env.clearTimers();
    }

    // ---------- 4. 重复完成消息只入账一次 ----------
    console.log('\n【4】重复完成消息 → 只计入一次');
    {
        const env = createEnv();
        const st = mkState([701, 702], { running: false, inFlightRow: 701 });
        env.setState(st);
        env.run(`advanceBatchColorForRow(701, 'message', 'cb_TEST')`);
        env.run(`advanceBatchColorForRow(701, 'poll', 'cb_TEST')`);
        env.run(`advanceBatchColorForRow(701, 'message', 'cb_TEST')`);
        ok(st.successCount === 1, `成功数只加一次（实际 ${st.successCount}）`);
        ok(st.currentIndex === 1, `索引只推进一次（实际 ${st.currentIndex}）`);
        env.clearTimers();
    }

    // ---------- 5. 旧任务迟到完成必须被拒绝 ----------
    console.log('\n【5】旧任务/非在途行的完成消息 → 拒绝');
    {
        const env = createEnv();
        const st = mkState([801, 802], { running: false, inFlightRow: 801 });
        env.setState(st);
        env.run(`advanceBatchColorForRow(801, 'message', 'cb_OLD_TASK')`);   // 旧任务标识
        ok(st.successCount === 0, `旧任务标识被拒绝（成功数 ${st.successCount}）`);
        env.run(`advanceBatchColorForRow(999, 'message', 'cb_TEST')`);       // 非在途行
        ok(st.successCount === 0, `非在途行被拒绝（成功数 ${st.successCount}）`);
        ok(st.inFlightRow === 801, '在途行未被误清');
        env.run(`advanceBatchColorForRow(801, 'poll', 'cb_TEST')`);          // 正确消息
        ok(st.successCount === 1, '正确消息仍可入账');
        env.clearTimers();
    }

    // ---------- 6. 暂停后完成不得自动派发 ----------
    console.log('\n【6】暂停后完成不自动派发；运行中完成才派发');
    {
        const env = createEnv();
        const st = mkState([901, 902, 903], { running: false, inFlightRow: 901 });
        env.setState(st);
        env.run(`advanceBatchColorForRow(901, 'message', 'cb_TEST')`);
        await tick(700);   // 若错误地走了 500ms 派发，这里能观察到
        ok(env.dispatched === 0, `暂停中完成不派发（dispatch ${env.dispatched}）`);

        // 恢复运行后，下一款完成应正常派发
        st.running = true;
        st.inFlightRow = 902;
        st.lastAdvancedRow = null;
        env.run(`advanceBatchColorForRow(902, 'message', 'cb_TEST')`);
        await tick(700);
        ok(env.dispatched === 1, `运行中完成正常派发下一款（dispatch ${env.dispatched}）`);
        env.clearTimers();
    }

    // ---------- 7. 全部完成时不残留待办 ----------
    console.log('\n【7】队列最后一款在暂停中完成 → 「继续」列表清空');
    {
        const env = createEnv();
        const st = mkState([1001], { running: false, inFlightRow: 1001, currentIndex: 0 });
        env.setState(st);
        env.run(`finishBatchColor(false, '资源不足')`);
        const atPause = env.run('getColorResumeRows()');
        ok(atPause.length === 0, `暂停时列表已排除在途款（实际 ${atPause.join(',')}）`);
        env.run(`advanceBatchColorForRow(1001, 'message', 'cb_TEST')`);
        const after = env.run('getColorResumeRows()');
        ok(st.successCount === 1 && after.length === 0, `完成后无残留待办（成功 ${st.successCount}，待办 ${after.join(',')}）`);
        env.clearTimers();
    }

    console.log('\n' + '='.repeat(50));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(50));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('测试运行异常:', e && e.stack || e);
    process.exit(1);
});
