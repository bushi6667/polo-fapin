// ============================================================
// 保存真实性校验 验收测试（P1：点保存成功 ≠ 保存成功）
// 覆盖：
//   1 成功信号 → 记账 verified:true
//   2 报错信号 → 不记账 ok:false（页面日志 error）
//   3 无信号   → 记账但 unverified:true（页面日志 warn，不打「✅ 已自动保存」）
//   4 unverified 行重发不被跳过
//   5 点击失败 → 不记账（原行为回归）
//   6 校验阶段抛异常 → 视为无法确认，不崩不误判失败
//   7 真实探针 saveVerifyProbe 的三类信号判定（假 DOM）
// 运行：node tests/test-save-verify.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '..');
const PAGE3_SRC = fs.readFileSync(path.join(root, 'chrome_extension/content/page3.js'), 'utf8');
const BG_SRC = fs.readFileSync(path.join(root, 'chrome_extension/background.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra === undefined ? '' : ' :: ' + extra}`); }
}
const delay = ms => new Promise(r => setTimeout(r, ms));

function fn(name, source = PAGE3_SRC) {
    const lines = source.split('\n');
    const start = lines.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
    const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
    assert(start >= 0 && end > start, '切片失败: ' + name);
    return lines.slice(start, end + 1).join('\n');
}
const logHas = (env, kw, type) => env.logs.some(l => l.m.includes(kw) && (type === undefined || l.t === type));

// ============================================================
// 后台沙箱：复用 test-publish-queue 的真实 background.js 环境，只补 scripting mock
// ============================================================
function backend(opts = {}) {
    const src = fs.readFileSync(path.join(__dirname, 'test-publish-queue.js'), 'utf8');
    const c = {
        require, __dirname: __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
        URLSearchParams, AbortController, TextDecoder, process
    };
    vm.createContext(c);
    vm.runInContext(src.slice(0, src.indexOf('(async function main()')), c);
    const env = vm.runInContext('createEnv()', c);
    const probeWaits = [];
    let probeCalls = 0;
    env.ctx.chrome.scripting.executeScript = async ({ func, args }) => {
        if (func && func.name === 'saveVerifyProbe') {
            probeCalls++;
            probeWaits.push(args && args[0]);
            if (opts.probeThrows) throw new Error('Cannot access contents of the page');
            return [{ result: opts.probeRaw === undefined ? { success: true, signals: ['successToast:保存成功'] } : opts.probeRaw }];
        }
        return [{ result: opts.fallbackClick === undefined ? true : opts.fallbackClick }];
    };
    return { env, probeWaits, probeCalls: () => probeCalls };
}

async function openTask(env, rows = [412, 415]) {
    const opened = await env.sendExternal({ action: 'openBatchPublish', rows, products: rows.map(row => ({ row })) });
    assert.equal(opened.ok, true, '任务创建失败: ' + JSON.stringify(opened));
    const tabId = env.store.polo_publish_task.currentTabId;
    const tab = env.tabs.find(t => t.id === tabId) || { url: '' };
    // sender.tab.url 用真实标签地址（后台用它判"提交后跳转"）；sender.url 给页3 地址（入口校验用）
    return {
        opened, tabId,
        sender: {
            tab: { id: tabId, url: tab.url },
            url: 'https://post.alibaba.com/product/publish?row=' + rows[0] + '&task=' + opened.taskId,
            frameId: 0
        }
    };
}
const savedMapOf = env => (env.store.polo_publish_verified_saved || {});

// ============================================================
// 页3 沙箱：真实 saveDraft / 真实 一键填入回调 / 真实 loadBatchProduct
// ============================================================
const ONCLICK_MARK = "document.getElementById('polo-autofill-btn').onclick = async () => {";
const ONCLICK_START = PAGE3_SRC.indexOf(ONCLICK_MARK);
const ONCLICK_END = PAGE3_SRC.indexOf('\n    };', ONCLICK_START);
const ONCLICK_BODY = PAGE3_SRC.slice(ONCLICK_START + ONCLICK_MARK.length, ONCLICK_END);

function pageEnv(opts = {}) {
    const events = [];
    const logs = [];
    const messages = [];
    const store = new Map(opts.store || []);
    const row = opts.row === undefined ? 412 : opts.row;
    const task = opts.task || 'pt_test';
    const saveBtn = {
        innerText: '保存', offsetHeight: 10,
        scrollIntoView() { events.push('scroll'); },
        getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 })
    };
    const btn = { disabled: false, style: {} };
    const c = {
        URLSearchParams,
        window: { location: { search: '?row=' + row + '&task=' + task } },
        sessionStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, v); },
            removeItem: k => { store.delete(k); }
        },
        currentProduct: null,
        document: {
            querySelectorAll: sel => (String(sel) === 'button' ? [saveBtn] : []),
            getElementById: id => (id === 'polo-autofill-btn' ? btn : null),
            addEventListener: () => {}
        },
        updateProductInfo() {},
        log: (m, t) => logs.push({ m, t }),
        ensureTabActive: async () => {},
        startHeartbeat: () => () => {},
        setTimeout: callback => setTimeout(callback, 0),
        sleep3: async () => {},
        getTaskFromUrl: () => task,
        getRowFromUrl: () => row,
        fillAllPage3: async () => { events.push('fill'); return opts.results || ['✅ 全部字段处理完毕']; },
        sendMessageRetry: async msg => {
            messages.push(msg);
            events.push('msg:' + msg.action);
            if (msg.action === 'getProductByRow') {
                return opts.productResp || {
                    ok: true, autoFillAllowed: true, filled: false,
                    data: { row, _publishTaskId: task, _publishFileKey: '' }
                };
            }
            if (msg.action === 'getUploadedRows') return opts.uploadedRows || { ok: true, rows: {} };
            if (msg.action === 'publishFilled') return { ok: true };
            if (msg.action === 'savePublishProduct') {
                const r = opts.saveResponse || { ok: true, verified: true, signals: ['successToast:保存成功'] };
                if (r === 'throw') throw new Error('CDP 连接断开');
                return r;
            }
            return { ok: true };
        }
    };
    vm.createContext(c);
    vm.runInContext([fn('saveDraft'), fn('loadBatchProduct')].join('\n'), c);
    return { c, events, logs, messages, store, saveBtn, btn, row, task };
}

async function runSingle(opts = {}) {
    const env = pageEnv(opts);
    env.c.currentProduct = { row: env.row, _publishTaskId: env.task, _publishFileKey: '' };
    vm.runInContext('__handler = async () => {' + ONCLICK_BODY + '\n};', env.c);
    await vm.runInContext('__handler()', env.c);
    return env;
}
async function runBatch(opts = {}) {
    const env = pageEnv(opts);
    await vm.runInContext('loadBatchProduct(' + env.row + ')', env.c);
    return env;
}

// ============================================================
// 探针：假 DOM 里的真实 saveVerifyProbe
// ============================================================
function probeEnv(fixture) {
    const el = (o = {}) => ({
        innerText: o.text || '',
        className: o.cls || '',
        disabled: !!o.disabled,
        getBoundingClientRect: () => (o.hidden ? { width: 0, height: 0 } : { width: 120, height: 18 }),
        closest: () => o.item || null
    });
    const styles = new Map();
    const styleOf = e => styles.get(e) || { display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(51, 51, 51)' };
    let hrefReads = 0;
    const c = {
        // 第一次读给 url0（探针的基线），之后给新地址 → 一次遍历即可测"跳转"
        location: { get href() { hrefReads++; return (fixture.navigated && hrefReads > 1) ? 'https://post.alibaba.com/product/publish?row=412&saved=1' : 'https://post.alibaba.com/product/publish?row=412'; } },
        window: { getComputedStyle: e => styleOf(e) },
        document: {
            querySelectorAll(sel) {
                const s = String(sel);
                if (s === 'button') return fixture.buttons || [];
                if (s.includes('form-item-help')) return fixture.helps || [];
                return fixture.toasts || [];
            }
        },
        setTimeout: f => setTimeout(f, 0),
        Promise, Date, Number, String, Array, Object, RegExp
    };
    if (fixture.styles) for (const [e, st] of fixture.styles) styles.set(e, st);
    vm.createContext(c);
    vm.runInContext(fn('saveVerifyProbe', BG_SRC), c);
    return { c, probe: waitMs => vm.runInContext('saveVerifyProbe(' + Number(waitMs || 0) + ')', c) };
}
const mkEl = (o) => ({
    innerText: o.text || '', className: o.cls || '', disabled: !!o.disabled,
    getBoundingClientRect: () => (o.hidden ? { width: 0, height: 0 } : { width: 120, height: 18 }),
    closest: () => o.item || null
});

// 轮次驱动的探针沙箱：同一个 DOM 查询在不同轮次返回不同内容，
// 用来验证「信号出现先后顺序」是否影响结论（即有没有提前 break）。
function seqProbe(fixture) {
    let round = 0;
    let first = true;
    const c = {
        location: { href: 'https://post.alibaba.com/product/publish?row=412' },
        window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(51, 51, 51)' }) },
        document: {
            querySelectorAll(sel) {
                const s = String(sel);
                if (s.includes('form-item-help')) {
                    if (!first) round++;      // 每轮（每次 helps 查询）推进一轮
                    first = false;
                    return fixture.helps ? fixture.helps(round) : [];
                }
                if (s === 'button') return fixture.buttons ? fixture.buttons(round) : [];
                return fixture.toasts ? fixture.toasts(round) : [];
            }
        },
        setTimeout: f => setTimeout(f, 0),
        Promise, Date, Number, String, Array, Object, RegExp
    };
    vm.createContext(c);
    vm.runInContext([fn('saveVerifyProbe', BG_SRC), fn('decideSaveVerification', BG_SRC)].join('\n'), c, { filename: 'background.js:save-verify-seq' });
    return {
        probe: waitMs => vm.runInContext('saveVerifyProbe(' + Number(waitMs || 0) + ')', c),
        decide: raw => vm.runInContext('decideSaveVerification', c)(raw)
    };
}

// ============================================================
(async () => {
    console.log('=== 保存真实性校验 验收测试 ===\n');

    // ------------------------------------------------------------
    console.log('【0】等待时长是常量，且传给页面探针（可测）');
    {
        ok(/const SAVE_VERIFY_WAIT_MS = (\d+);/.test(BG_SRC), 'SAVE_VERIFY_WAIT_MS 是顶层常量');
        const { env, probeWaits } = backend();
        await delay(100);
        const { sender } = await openTask(env);
        await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(probeWaits.length === 1 && probeWaits[0] === env.run('SAVE_VERIFY_WAIT_MS'), '探针收到 SAVE_VERIFY_WAIT_MS（实际 ' + probeWaits[0] + '）');
        ok(probeWaits[0] >= 2000 && probeWaits[0] <= 3000, '等待时长在 2~3 秒区间');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【1】点击成功 + 成功信号 → 记账 verified:true');
    {
        const { env, probeCalls } = backend({ probeRaw: { success: true, signals: ['successToast:保存成功'] } });
        await delay(100);
        const { sender } = await openTask(env);
        const resp = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(resp && resp.ok === true, 'ok:true', JSON.stringify(resp));
        ok(resp.verified === true, 'verified:true');
        ok(resp.unverified === false, 'unverified:false');
        ok(Array.isArray(resp.signals) && resp.signals.length === 1, 'signals 回传成功信号');
        ok(resp.row === 412 && resp.source === 'page3_save_click' && resp.fileKey === '', '既有字段 row/source/fileKey 未丢');
        const rec = savedMapOf(env)[''][412];
        ok(!!rec && rec.verified === true, '已写入保存记录且 verified:true');
        ok(!rec.unverified, '未被标记 unverified');
        ok(probeCalls() === 1, '保存后执行了 1 次校验');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.savedCount === 1 && st.unverifiedSavedCount === 0, `面板已保存 1 / 未确认 0（实际 ${st.savedCount}/${st.unverifiedSavedCount}）`);
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【2】点击成功 + 报错提示 → 不记账，返回 ok:false');
    {
        const { env } = backend({ probeRaw: { error: true, signals: ['formError:品牌不能为空'] } });
        await delay(100);
        const { sender } = await openTask(env);
        const resp = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(resp && resp.ok === false, 'ok:false（明确失败）', JSON.stringify(resp));
        ok(resp.verified === false, 'verified:false');
        ok(String(resp.error || '').includes('平台校验未通过'), '错误说明是平台校验未通过');
        ok((resp.signals || []).some(s => s.includes('formError')), 'signals 带上报错来源');
        ok(savedMapOf(env)[''] === undefined || savedMapOf(env)[''][412] === undefined, '没有写入保存记录（不会静默记成已保存）');
        const logs = env.store.polo_publish_log || [];
        ok(logs.some(l => l.level === 'saveRejected' && Number(l.row) === 412), '后台诊断日志记 saveRejected');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.savedCount === 0, `面板已保存数不涨（实际 ${st.savedCount}）`);
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【3】点击成功 + 无任何信号 → 记账但 unverified:true');
    {
        const { env } = backend({ probeRaw: { signals: [] } });
        await delay(100);
        const { sender } = await openTask(env);
        const resp = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(resp && resp.ok === true, 'ok:true（点了保存，队列照旧推进）');
        ok(resp.verified === false && resp.unverified === true, 'verified:false / unverified:true');
        const rec = savedMapOf(env)[''][412];
        ok(!!rec && rec.unverified === true, '记录带 unverified:true');
        ok(!!rec && rec.source === 'page3_save_click', '记录保留 source');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.savedCount === 1 && st.unverifiedSavedCount === 1, `已保存 1 且未确认 1（实际 ${st.savedCount}/${st.unverifiedSavedCount}）`);
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【4】unverified 行重发不被跳过（getUploadedRows / autoFillAllowed 放宽）');
    {
        const { env } = backend();
        await delay(100);
        const { opened, sender } = await openTask(env);
        // 后台判定：unverified → autoFillAllowed=true；verified → false
        env.run("chrome.storage.local.set({ polo_publish_verified_saved: { '': { 412: { at: Date.now(), source: 'page3_save_click', unverified: true } } } })");
        await delay(30);
        let p = await env.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: opened.taskId }, sender);
        ok(p && p.autoFillAllowed === true, 'unverified 行允许重填（autoFillAllowed=true）', JSON.stringify(p && p.autoFillAllowed));
        env.run("chrome.storage.local.set({ polo_publish_verified_saved: { '': { 412: { at: Date.now(), source: 'page3_save_click', verified: true } } } })");
        await delay(30);
        p = await env.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: opened.taskId }, sender);
        ok(p && p.autoFillAllowed === false, 'verified 行仍禁止重填（autoFillAllowed=false）');
        const up = await env.sendInternal({ action: 'getUploadedRows', taskId: opened.taskId }, sender);
        ok(up.ok === true && up.rows[412] && up.rows[412].verified === true, 'getUploadedRows 原样返回记录（助手页展示不变）');
        await env.run('stopPublishTick()');
    }
    {
        const task = 'pt_test';
        const unverified = await runBatch({ uploadedRows: { ok: true, rows: { 412: { at: 1, source: 'page3_save_click', unverified: true } } } });
        ok(unverified.events.filter(e => e === 'fill').length === 1, '页3：unverified 行仍然自动填入（不跳过）');
        ok(logHas(unverified, '上次保存未确认', 'warn'), '页3：warn 说明上次保存未确认');
        ok(unverified.messages.filter(m => m.action === 'publishFilled' && !m.skipped).length === 1, '页3：正常上报（不按 skipped 跳过）');

        const verified = await runBatch({ uploadedRows: { ok: true, rows: { 412: { at: 1, source: 'page3_save_click', verified: true } } } });
        ok(verified.events.filter(e => e === 'fill').length === 0, '页3：verified 行不重填');
        ok(verified.messages.some(m => m.action === 'publishFilled' && m.skipped === true), '页3：verified 行上报 skipped 推进队列');
        ok(task === 'pt_test', '夹具任务标识一致');
    }

    // ------------------------------------------------------------
    console.log('\n【5】点击失败（CDP + elementFromPoint 兜底都失败）→ 不记账（回归）');
    {
        const { env, probeCalls } = backend({ fallbackClick: false });
        await delay(100);
        const { sender } = await openTask(env);
        env.run('realClickCDP = async () => ({ ok: false })');
        const resp = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(resp && resp.ok === false, 'ok:false');
        ok(String(resp.error || '').includes('保存按钮未点击'), '错误说明按钮未点击');
        ok(savedMapOf(env)[''] === undefined || savedMapOf(env)[''][412] === undefined, '不记账');
        ok(probeCalls() === 0, '点击都没成功就不做保存校验');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【6】校验阶段抛异常（executeScript 失败）→ 视为无法确认，不崩不误判失败');
    {
        const { env } = backend({ probeThrows: true });
        await delay(100);
        const { sender } = await openTask(env);
        const resp = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(resp && resp.ok === true, 'ok:true（不因校验异常而丢保存动作）', JSON.stringify(resp));
        ok(resp.verified === false && resp.unverified === true, 'verified:false / unverified:true');
        ok(!/平台校验未通过/.test(String(resp.error || '')), '不误判成明确失败');
        ok(savedMapOf(env)[''][412].unverified === true, '记录为 unverified（允许重发重填）');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【6b】校验抛异常但标签 URL 已变（提交后跳转）→ 算已验证');
    {
        const { env } = backend({ probeThrows: true });
        await delay(100);
        const { sender } = await openTask(env);
        const tab = env.tabs.find(t => t.id === sender.tab.id);
        tab.url = 'https://post.alibaba.com/product/publish/success?row=412';
        const resp = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(resp && resp.ok === true && resp.verified === true, 'ok:true / verified:true', JSON.stringify(resp));
        ok((resp.signals || []).some(s => s.startsWith('url:')), 'signals 记下 URL 变化');
        ok(savedMapOf(env)[''][412].unverified === undefined, '记录不是 unverified（重发不再重填）');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('\n【7】页面探针 saveVerifyProbe：三类信号判定');
    {
        const e1 = probeEnv({ helps: [mkEl({ text: '请输入3-128个字符', cls: 'next-form-item-help' })] });
        let r = await e1.probe(0);
        ok(r.error === false && r.success === false, '常驻占位提示「请输入…」不算报错（避免误判）');

        const e2 = probeEnv({ helps: [mkEl({ text: '请输入标题', cls: 'next-form-item-help error' })] });
        r = await e2.probe(0);
        ok(r.error === true && r.signals.some(s => s.startsWith('formError:')), '带 error 类的 help → 报错');

        const item = { className: 'next-form-item has-error' };
        const e3 = probeEnv({ helps: [mkEl({ text: '请输入标题', item })] });
        r = await e3.probe(0);
        ok(r.error === true, '所在表单项 has-error → 报错');

        const e4 = probeEnv({ helps: [mkEl({ text: '品牌不能为空' })] });
        r = await e4.probe(0);
        ok(r.error === true, '硬错误文案（不能为空）→ 报错');

        const e5 = probeEnv({ toasts: [mkEl({ text: '保存失败，请检查必填项', cls: 'next-message' })] });
        r = await e5.probe(0);
        ok(r.error === true && r.signals.some(s => s.startsWith('errorToast:')), '错误 toast → 报错');

        const e6 = probeEnv({ toasts: [mkEl({ text: '保存成功', cls: 'next-message' })] });
        r = await e6.probe(0);
        ok(r.success === true && r.error === false, '成功 toast → 成功信号');

        const e7 = probeEnv({ navigated: true });
        r = await e7.probe(0);
        ok(r.navigated === true && r.success === false, 'URL 变化 → 成功信号（navigated）');

        const e8 = probeEnv({ buttons: [mkEl({ text: '保存', disabled: true })] });
        r = await e8.probe(0);
        ok(r.buttonDisabled === true, '保存按钮变 disabled → 成功信号');

        const e9 = probeEnv({ buttons: [] });
        r = await e9.probe(0);
        ok(r.buttonGone === true, '保存按钮消失 → 成功信号');

        const e10 = probeEnv({ buttons: [mkEl({ text: '保存', disabled: false })] });
        r = await e10.probe(0);
        ok(!r.error && !r.success && !r.navigated && !r.buttonGone && !r.buttonDisabled && r.signals.length === 0, '无信号 → 全空（后续按未确认处理）');

        const e11 = probeEnv({ helps: [mkEl({ text: '品牌不能为空', hidden: true })] });
        r = await e11.probe(0);
        ok(r.error === false, '不可见（0 尺寸）的报错不算信号');
    }

    // ------------------------------------------------------------
    console.log('\n【7b】信号顺序：buttonDisabled 不提前结束轮询 + 常驻「请上传」不算失败');
    {
        // 1) 提交后按钮立刻 disabled，异步拒绝文案 150ms 后才出现 → 必须仍能采到 error 并判 failure
        const t0 = Date.now();
        const e1 = seqProbe({
            buttons: () => [mkEl({ text: '保存', disabled: true })],
            helps: () => (Date.now() - t0 >= 150
                ? [mkEl({ text: '品牌不能为空', cls: 'next-form-item-help error' })]
                : [])
        });
        let r = await e1.probe(600);
        const cost1 = Date.now() - t0;
        ok(r.buttonDisabled === true, 'buttonDisabled 先命中并已记录');
        ok(r.error === true && r.signals.some(s => s.startsWith('formError:')),
            '延迟 150ms 才出现的拒绝文案仍被采到（轮询没在 buttonDisabled 处提前 break）', JSON.stringify(r.signals));
        ok(cost1 >= 150, `轮询确实跑过了 150ms（实际 ${cost1}ms）`);
        let d = e1.decide(r);
        ok(d.failure === true && d.verified === false, '最终判 failure（不是 unverified）');

        // 2) 只有 buttonDisabled、整窗口内无其它信号 → 跑满窗口后按未确认处理
        const t1 = Date.now();
        const e2 = seqProbe({ buttons: () => [mkEl({ text: '保存', disabled: true })] });
        r = await e2.probe(400);
        const cost2 = Date.now() - t1;
        ok(r.buttonDisabled === true && r.error === false && r.success === false, '只有 buttonDisabled：不判失败也不判成功');
        ok(cost2 >= 350, `等待窗口被跑满（实际 ${cost2}ms / 目标 400ms）`);
        d = e2.decide(r);
        ok(d.verified === false && d.failure === false, '最终判 unverified（不是 failure）');

        // 3) 常驻提示「请上传主图」但没有任何报错样式 → 不判失败，只留诊断信号
        const e3 = seqProbe({
            buttons: () => [mkEl({ text: '保存', disabled: false })],
            helps: () => [mkEl({ text: '请上传主图', cls: 'next-form-item-help' })]
        });
        r = await e3.probe(0);
        ok(r.error === false && r.success === false, '「请上传主图」无 error 类 → 不判失败');
        ok(r.signals.some(s => s.startsWith('formWarnText:')), '只记诊断信号 formWarnText', JSON.stringify(r.signals));
        ok(!r.signals.some(s => s.startsWith('formError:')), '不会被记成 formError');
        d = e3.decide(r);
        ok(d.failure === false && d.verified === false, '「请上传主图」无 error 类 → 按未确认处理');

        // 4) 同一句文案但带 error 类 → 判失败
        const e4 = seqProbe({
            buttons: () => [mkEl({ text: '保存', disabled: false })],
            helps: () => [mkEl({ text: '请上传主图', cls: 'next-form-item-help error' })]
        });
        r = await e4.probe(0);
        ok(r.error === true && r.signals.some(s => s.startsWith('formError:')), '「请上传主图」带 error 类 → 判失败');
        ok(e4.decide(r).failure === true, '带 error 类时结论是 failure');

        // 5) 强校验语义（必填）仍允许纯文案命中 —— 既有强度不能退化
        const e5 = seqProbe({
            buttons: () => [mkEl({ text: '保存', disabled: false })],
            helps: () => [mkEl({ text: '此字段必填', cls: 'next-form-item-help' })]
        });
        r = await e5.probe(0);
        ok(r.error === true, '「此字段必填」无 error 类 → 仍判失败');
        ok(e5.decide(r).failure === true, '必填类纯文案 → failure');
    }

    // ------------------------------------------------------------
    console.log('\n【8】页3 saveDraft：verified / unverified / 明确失败 的日志级别');
    {
        const good = await runSingle({ saveResponse: { ok: true, verified: true, signals: ['successToast:保存成功'] } });
        ok(logHas(good, '平台已确认保存成功', 'success'), 'verified → success 日志');
        ok(logHas(good, '✅ 已自动保存', 'success'), 'verified → 打「✅ 已自动保存」');
        ok(good.messages.filter(m => m.action === 'publishFilled').length === 1, 'verified → 仍上报 publishFilled');

        const unv = await runSingle({ saveResponse: { ok: true, verified: false, unverified: true, signals: [] } });
        ok(logHas(unv, '已点击保存但未确认成功', 'warn'), 'unverified → warn「已点击保存但未确认成功」');
        ok(!logHas(unv, '✅ 已自动保存'), 'unverified → 不打「✅ 已自动保存」');
        ok(logHas(unv, '自动保存未完成', 'warn'), 'unverified → 调用点 warn 自动保存未完成');
        ok(unv.messages.filter(m => m.action === 'publishFilled').length === 1, 'unverified → 队列照旧推进（publishFilled 仍发 1 次）');

        const bad = await runSingle({ saveResponse: { ok: false, error: '平台校验未通过，未标记已保存' } });
        ok(logHas(bad, '平台校验未通过', 'error'), '明确失败 → error 级别日志');
        ok(!logHas(bad, '✅ 已自动保存'), '明确失败 → 不打「✅ 已自动保存」');
        ok(logHas(bad, '自动保存未完成', 'error'), '明确失败 → 调用点用 error 级别');
        ok(bad.messages.filter(m => m.action === 'publishFilled').length === 1, '明确失败 → 队列仍推进（不卡死）');
        ok(bad.btn.disabled === false, '按钮恢复可用');

        const thrown = await runSingle({ saveResponse: 'throw' });
        ok(logHas(thrown, '自动保存异常', 'warn'), 'saveDraft 抛异常仍按 warn 处理（不崩）');
        ok(thrown.messages.filter(m => m.action === 'publishFilled').length === 1, '异常时 publishFilled 仍发出');
    }

    console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
    if (fail) console.log('失败项:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
