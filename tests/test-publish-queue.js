// ============================================================
// 发品队列/保存状态 验收测试
// 方式：把 chrome_extension/background.js 的真实源码放进 Node vm 执行，
//       在模拟的 chrome.storage / tabs / alarms / system.memory / fetch 上
//       直接调用生产函数与消息入口（不复制业务逻辑）。
// 运行：node tests/test-publish-queue.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'background.js'), 'utf8');

const PHYS_TOTAL = 16 * 1024 * 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

// ---------- 模拟环境 ----------
function createEnv(opts = {}) {
    const store = {};
    // 预置 storage（用于模拟后台冷启动：源码执行时 recoverPublishTaskOnStartup 会读它）
    if (opts.initialStore) {
        for (const k of Object.keys(opts.initialStore)) store[k] = JSON.parse(JSON.stringify(opts.initialStore[k]));
    }
    const tabs = [];
    const createdUrls = [];
    const alarms = {};
    const L = { onMessage: [], onMessageExternal: [], onAlarm: [], onRemoved: [], onConnect: [], onInstalled: [], onStartup: [] };
    let nextTabId = 100;

    // 预置已打开的目标页面
    const preopened = opts.preopenedPages || 0;
    for (let i = 0; i < preopened; i++) {
        tabs.push({ id: nextTabId++, url: 'https://post.alibaba.com/product/publish?row=' + (900 + i) });
    }
    // 预置指定标签（模拟后台重启时该任务标签仍在）
    if (opts.initialTabs) {
        for (const t of opts.initialTabs) tabs.push({ id: t.id, url: t.url });
    }

    const storageLocal = {
        get(keys, cb) {
            let out = {};
            if (keys === null || keys === undefined) out = Object.assign({}, store);
            else if (typeof keys === 'string') { if (keys in store) out[keys] = store[keys]; }
            else if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = store[k]; }
            else if (typeof keys === 'object') { for (const k of Object.keys(keys)) out[k] = (k in store) ? store[k] : keys[k]; }
            // 深拷贝快照，模拟 storage 的序列化语义
            const snap = {};
            for (const k of Object.keys(out)) snap[k] = JSON.parse(JSON.stringify(out[k]));
            if (cb) { setTimeout(() => cb(snap), 0); return; }
            return Promise.resolve(snap);
        },
        set(obj, cb) {
            for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k]));
            if (cb) setTimeout(cb, 0);
        },
        remove(keys, cb) {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete store[k];
            if (cb) setTimeout(cb, 0);
        }
    };

    const chrome = {
        runtime: {
            id: 'test-extension-id',
            lastError: null,
            getManifest: () => ({ version: '1.1.0' }),
            onMessage: { addListener: f => L.onMessage.push(f) },
            onMessageExternal: { addListener: f => L.onMessageExternal.push(f) },
            onConnectExternal: { addListener: f => L.onConnect.push(f) },
            onInstalled: { addListener: f => L.onInstalled.push(f) },
            onStartup: { addListener: f => L.onStartup.push(f) },
            sendMessage: () => {},
            connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} })
        },
        storage: { local: storageLocal },
        tabs: {
            query: async () => tabs.map(t => ({ id: t.id, url: t.url })),
            get: async (id) => {
                const t = tabs.find(x => x.id === id);
                if (!t) throw new Error('No tab with id ' + id);
                return t;
            },
            create: async ({ url }) => {
                const t = { id: nextTabId++, url };
                tabs.push(t);
                createdUrls.push(url);
                return t;
            },
            remove: async (id) => {
                const i = tabs.findIndex(x => x.id === id);
                if (i >= 0) tabs.splice(i, 1);
            },
            sendMessage: async () => {},
            onRemoved: { addListener: f => L.onRemoved.push(f) },
            onUpdated: { addListener: () => {} },
            update: async () => {}
        },
        alarms: {
            create: (name, info) => { alarms[name] = info; },
            clear: (name) => { delete alarms[name]; },
            onAlarm: { addListener: f => L.onAlarm.push(f) }
        },
        system: {
            memory: {
                getInfo: (cb) => {
                    if (opts.systemMemoryFails) return; // 回调永不触发 → 模拟挂起
                    const avail = (opts.physAvailGiB === undefined) ? 10 * GIB : opts.physAvailGiB * GIB;
                    cb({ capacity: PHYS_TOTAL, availableCapacity: avail });
                }
            }
        },
        debugger: { attach: async () => {}, sendCommand: async () => {} },
        downloads: { onDeterminingFilename: { addListener: () => {} } },
        webNavigation: { getAllFrames: async () => [] },
        scripting: {}
    };

    let memCalls = 0;
    const fetchMock = async (url) => {
        if (String(url).indexOf('/mem-info') < 0) throw new Error('unexpected fetch ' + url);
        memCalls++;
        if (opts.commitFetchFails) throw new Error('connect ECONNREFUSED');
        if (opts.commitFetchHang) return { ok: true, json: () => new Promise(() => {}) }; // 响应体挂起
        if (opts.commitFetchDelayMs) await new Promise(r => setTimeout(r, opts.commitFetchDelayMs));
        const limit = (opts.commitLimitGiB === undefined ? 64 : opts.commitLimitGiB) * GIB;
        const free = (opts.commitFreeMiB === undefined ? 8192 : opts.commitFreeMiB) * 1024 * 1024;
        return {
            ok: true,
            json: async () => ({ ok: true, commitLimitBytes: limit, committedBytes: limit - free, sampledAt: Date.now() })
        };
    };

    const sandbox = {
        chrome, fetch: fetchMock,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Error,
        URLSearchParams, AbortController, Blob: class {}, TextDecoder,
        importScripts: () => {}   // MV3 SW 的 importScripts（测试中不需要真实加载）
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SRC, ctx, { filename: 'background.js' });

    const run = (expr) => vm.runInContext(expr, ctx);

    // 内部消息入口（content script 走这条）
    const sendInternal = (request, sender) => new Promise((resolve) => {
        let done = false;
        const cb = (r) => { if (!done) { done = true; resolve(r); } };
        for (const f of L.onMessage) { if (f(request, sender || {}, cb) === true) break; }
        setTimeout(() => cb(undefined), 600);
    });

    // 外部页面入口（file:// 发品助手页走这条）
    const sendExternal = (request) => new Promise((resolve) => {
        let done = false;
        const cb = (r) => { if (!done) { done = true; resolve(r); } };
        const sender = { url: 'file:///C:/Users/x/Desktop/测试文件 - 副本/xlsx发品/发品助手.html', id: 'test-extension-id' };
        for (const f of L.onMessageExternal) { if (f(request, sender, cb) === true) break; }
        setTimeout(() => cb(undefined), 800);
    });

    return { ctx, run, store, tabs, createdUrls, alarms, L, sendInternal, sendExternal };
}

function seedUploaded(env, rows) {
    env.store['uploaded'] = rows; // getFilePrefix() 为空时的键名
}

// 等所有排队的微任务/定时器跑完
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

// 模拟 page3 逐款上报「填写完成」（生产环境由页3自动填入后上报）
async function driveFills(env, maxFills) {
    let n = 0;
    const cap = maxFills === undefined ? 500 : maxFills;
    while (n < cap) {
        const t = await env.run('loadPublishTask()');
        if (!t || t.currentRow === null) break;
        await env.sendInternal({ action: 'publishFilled', row: t.currentRow, taskId: t.taskId },
            { tab: { id: t.currentTabId }, frameId: 0 });
        n++;
        await tick(30);
    }
    return n;
}

// ============================================================
(async function main() {
    console.log('=== 发品队列 / 保存状态 验收测试 ===');
    console.log('（直接执行 background.js 生产函数，非复制逻辑）\n');

    // ---------- 场景 1/2：分批闸门 ----------
    console.log('【1】120 款 / 批次 50 / 资源充足 → 预填 50 后暂停，剩 70，不开第 51');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 50 } });
        const rows = Array.from({ length: 120 }, (_, i) => i + 1);
        const resp = await env.sendExternal({ action: 'openBatchPublish', rows });
        await tick(200);
        const filled = await driveFills(env, 50);
        await tick(200);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(resp && resp.ok, '任务创建成功', JSON.stringify(resp));
        ok(filled === 50, `驱动了 50 次填写完成（实际 ${filled}）`);
        ok(st && st.state === 'paused', '已暂停', st && st.state);
        ok(st && st.pauseReason === 'batch', '暂停原因=batch', st && st.pauseReason);
        ok(st && st.remaining === 70, `剩余 70（实际 ${st && st.remaining}）`);
        ok(env.createdUrls.length === 50, `只开了 50 个页面（实际 ${env.createdUrls.length}）`);
        ok(st && st.batchOpened === 50, `本批已开 50（实际 ${st && st.batchOpened}）`);
        ok(st && st.filledCount === 50, `整体已预填 50（实际 ${st && st.filledCount}）`);
        ok(st && st.savedCount === 0 && st.pendingSaveCount === 50, '未保存时保存数 0 / 待保存 50');
    }

    console.log('\n【2】60 款 → 50 后暂停；继续 → 预填剩下 10');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 50 } });
        const rows = Array.from({ length: 60 }, (_, i) => i + 1);
        await env.sendExternal({ action: 'openBatchPublish', rows });
        await tick(200);
        await driveFills(env, 50);
        await tick(200);
        let st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.remaining === 10, `暂停且剩 10（实际 ${st.remaining}）`);
        ok(env.createdUrls.length === 50, `第一班开 50 页（实际 ${env.createdUrls.length}）`);
        const resumed = await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(200);
        ok(resumed && resumed.ok, '继续成功', JSON.stringify(resumed));
        await driveFills(env, 10);
        await tick(200);
        st = await env.sendExternal({ action: 'getPublishState' });
        ok(env.createdUrls.length === 60, `继续后共开 60 页（实际 ${env.createdUrls.length}）`);
        ok(st && st.remaining === 0 && st.state === 'done', '全部预填完成', st && st.state);
    }

    console.log('\n【3】不足 50 款 → 全部预填后结束，保存数仍为 0');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [1, 2, 3] });
        await tick(200);
        await driveFills(env, 3);
        await tick(200);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'done', '状态 done', st.state);
        ok(st.filledCount === 3, `已预填 3（实际 ${st.filledCount}）`);
        ok(st.savedCount === 0, '保存数 0（未点保存）');
        ok(st.pendingSaveCount === 3, `待保存 3（实际 ${st.pendingSaveCount}）`);
        ok(env.createdUrls.length === 3, `开 3 页（实际 ${env.createdUrls.length}）`);
    }

    // ---------- 场景：暂停时当前款完成 ----------
    console.log('\n【4】暂停时当前款填写完成：入账但不再开新页；继续不重复开款');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [11, 12, 13] });
        await tick(250);
        const t0 = env.run('loadPublishTask()').then ? await env.run('loadPublishTask()') : null;
        const curTab = t0.currentTabId, curRow = t0.currentRow;
        ok(curRow === 11 && env.createdUrls.length === 1, '当前 row11 / 1 页');
        // 手动暂停
        await env.sendExternal({ action: 'pausePublishQueue' });
        await tick(120);
        // 暂停期间当前款完成
        const r1 = await env.sendInternal({ action: 'publishFilled', row: 11, taskId: t0.taskId }, { tab: { id: curTab }, frameId: 0 });
        await tick(200);
        ok(r1 && r1.ok, '暂停期间的填写完成被接受', JSON.stringify(r1));
        const t1 = await env.run('loadPublishTask()');
        ok(t1.remaining.length === 2 && t1.filledCount === 1, `入账：剩 2 已填 1（剩 ${t1.remaining.length} / 填 ${t1.filledCount}）`);
        ok(env.createdUrls.length === 1, `仍只开 1 页（实际 ${env.createdUrls.length}）`);
        // 继续
        await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(env.createdUrls.length === 2, `继续后开第 2 页（实际 ${env.createdUrls.length}）`);
        const urls = env.createdUrls.join(' ');
        ok(urls.indexOf('row=12') >= 0 && urls.indexOf('row=11') === urls.lastIndexOf('row=11'), '未重复打开 row11');
    }

    // ---------- 场景：重复完成消息 ----------
    console.log('\n【5】两个相同完成消息并发 → 只推进一次，不开两页');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [21, 22, 23] });
        await tick(250);
        const t0 = await env.run('loadPublishTask()');
        const tab = t0.currentTabId;
        const msg = { action: 'publishFilled', row: 21, taskId: t0.taskId };
        const rs = await Promise.all([
            env.sendInternal(Object.assign({}, msg), { tab: { id: tab }, frameId: 0 }),
            env.sendInternal(Object.assign({}, msg), { tab: { id: tab }, frameId: 0 })
        ]);
        await tick(300);
        const okCount = rs.filter(x => x && x.ok).length;
        ok(okCount === 1, `只有 1 个成功（实际 ${okCount}）`);
        ok(env.createdUrls.length === 2, `只开 2 页（实际 ${env.createdUrls.length}）`);
        const t1 = await env.run('loadPublishTask()');
        ok(t1.filledCount === 1 && t1.remaining.length === 2, `只推进一行（填 ${t1.filledCount} 剩 ${t1.remaining.length}）`);
    }

    // ---------- 场景：taskId / 标签 / 行号 校验 ----------
    console.log('\n【6】任务标识与来源校验：缺 taskId / 错标签 / 错行 一律拒绝');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [31, 32] });
        await tick(250);
        const t0 = await env.run('loadPublishTask()');
        const tab = t0.currentTabId;
        const a = await env.sendInternal({ action: 'publishFilled', row: 31 }, { tab: { id: tab }, frameId: 0 });
        ok(a && !a.ok, '缺 taskId → 拒绝', JSON.stringify(a));
        const b = await env.sendInternal({ action: 'publishFilled', row: 31, taskId: 'pt_old_x' }, { tab: { id: tab }, frameId: 0 });
        ok(b && !b.ok, '旧任务 taskId → 拒绝');
        const c = await env.sendInternal({ action: 'publishFilled', row: 31, taskId: t0.taskId }, { tab: { id: 99999 }, frameId: 0 });
        ok(c && !c.ok, '非当前标签 → 拒绝');
        const d = await env.sendInternal({ action: 'publishFilled', row: 99, taskId: t0.taskId }, { tab: { id: tab }, frameId: 0 });
        ok(d && !d.ok, '行号不匹配 → 拒绝');
        const e = await env.sendInternal({ action: 'publishFilled', row: 31, taskId: t0.taskId }, { tab: { id: tab }, frameId: 3 });
        ok(e && !e.ok, '非顶层框架 → 拒绝');
        const f = await env.sendInternal({ action: 'publishFilled', row: 31, taskId: t0.taskId }, { tab: { id: tab }, frameId: 0 });
        ok(f && f.ok, '正确来源 → 接受');
        const t1 = await env.run('loadPublishTask()');
        ok(t1.filledCount === 1, '只有合法消息推进了一次');
    }

    // ---------- 场景：页面上限 ----------
    console.log('\n【7】已开 60 个目标页面 → 禁止开新页并暂停');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, preopenedPages: 60 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [41, 42] });
        await tick(300);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.pauseReason === 'pageLimit', `暂停原因=pageLimit（实际 ${st.pauseReason}）`);
        ok(env.createdUrls.length === 0, `未开新页（实际 ${env.createdUrls.length}）`);
        ok(st.pages === 60, `页面计数 60（实际 ${st.pages}）`);
    }

    // ---------- 场景：内存闸门（复现真实日志口径） ----------
    console.log('\n【8】物理余量 10GiB + 提交余量 120MiB → 必须暂停');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 120 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [51, 52] });
        await tick(300);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.pauseReason === 'memory', `暂停（实际 ${st.pauseReason}）`);
        ok(env.createdUrls.length === 0, '未开页');
    }

    console.log('\n【9】物理余量低于阈值 → 暂停');
    {
        const env = createEnv({ physAvailGiB: 1, commitFreeMiB: 8192 }); // 1GiB < 1500MiB 默认阈值
        await env.sendExternal({ action: 'openBatchPublish', rows: [61] });
        await tick(300);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.pauseReason === 'memory', `暂停（实际 ${st.pauseReason}）`);
        ok(env.createdUrls.length === 0, '未开页');
    }

    console.log('\n【10】内存接口异常 / 挂起 → 暂停并说明原因（禁止静默放行）');
    {
        const envA = createEnv({ commitFetchFails: true });
        await envA.sendExternal({ action: 'openBatchPublish', rows: [71] });
        await tick(300);
        const stA = await envA.sendExternal({ action: 'getPublishState' });
        ok(stA.state === 'paused' && stA.pauseReason === 'monitorFail', `提交端点不可用 → 暂停（实际 ${stA.pauseReason}）`);
        ok(envA.createdUrls.length === 0, '未开页');

        const envB = createEnv({ systemMemoryFails: true });
        await envB.sendExternal({ action: 'openBatchPublish', rows: [72] });
        await tick(3600); // 等 3 秒超时
        const stB = await envB.sendExternal({ action: 'getPublishState' });
        ok(stB.state === 'paused' && stB.pauseReason === 'monitorFail', `物理内存回调挂起 → 暂停（实际 ${stB.pauseReason}）`);
        ok(envB.createdUrls.length === 0, '未开页');
    }

    // ---------- 场景：切文件 / 关标签 ----------
    console.log('\n【11】切换 Excel 文件 → 先暂停任务');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [81, 82] });
        await tick(250);
        await env.sendExternal({ action: 'setCurrentFilename', filename: '另一个文件.xlsx' });
        await tick(250);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.pauseReason === 'fileSwitch', `暂停原因=fileSwitch（实际 ${st.pauseReason}）`);
        ok(env.createdUrls.length === 1, `切换后未再开页（实际 ${env.createdUrls.length}）`);
    }

    console.log('\n【12】当前标签被关闭 → 暂停并保留该行');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [91, 92] });
        await tick(250);
        const t0 = await env.run('loadPublishTask()');
        for (const f of env.L.onRemoved) f(t0.currentTabId);
        await tick(250);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.pauseReason === 'tabClosed', `暂停原因=tabClosed（实际 ${st.pauseReason}）`);
        ok(st.currentRow === 91, `当前行保留（实际 ${st.currentRow}）`);
        ok(st.remaining === 2, '该行未从队列移除');
    }

    // ---------- 场景：已核实保存跳过 ----------
    console.log('\n【13】已核实保存的行被跳过 → 正常推进不卡死');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        // 预置：该文件下 row101 已核实保存
        env.store['polo_publish_verified_saved'] = { '': { 101: { at: Date.now() } } };
        await env.sendExternal({ action: 'openBatchPublish', rows: [101, 102] });
        await tick(300);
        const up = await env.sendExternal({ action: 'getUploadedRows' });
        ok(up && up.rows && up.rows[101], '已核实保存可查询');
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        env2.store['polo_publish_verified_saved'] = { '': { 101: { at: Date.now() } } };
        await env2.sendExternal({ action: 'openBatchPublish', rows: [102, 103] });
        await tick(250);
        const t0 = await env2.run('loadPublishTask()');
        // 模拟 page3 跳过已保存：上报 skipped
        await env2.sendInternal({ action: 'publishFilled', row: 102, taskId: t0.taskId, skipped: true }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(300);
        const st = await env2.sendExternal({ action: 'getPublishState' });
        ok(st.remaining === 1 && env2.createdUrls.length === 2, `跳过仍推进（剩 ${st.remaining}，开页 ${env2.createdUrls.length}）`);
    }

    // ---------- 场景：旧标记不作为保存依据 ----------
    console.log('\n【14】旧 uploaded=true → 仅历史待核，不计入已保存');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        seedUploaded(env, { 111: true, 112: true });
        await env.sendExternal({ action: 'openBatchPublish', rows: [111, 112] });
        await tick(300);
        const st = await env.sendExternal({ action: 'getPublishState' });
        const up = await env.sendExternal({ action: 'getUploadedRows' });
        ok(st.savedCount === 0, `已保存数 0（实际 ${st.savedCount}）`);
        ok(up && up.legacy && up.legacy[111], '旧标记在 legacy 中可见');
        ok(up && up.rows && Object.keys(up.rows).length === 0, 'legacy 不进入已保存集合');
    }

    // ---------- 场景：markUploaded 拒绝 & publishCompleted 不推进 ----------
    console.log('\n【15】markUploaded 拒绝；旧 publishCompleted 不推进队列');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [121, 122] });
        await tick(250);
        const mu = await env.sendExternal({ action: 'markUploaded', row: 121 });
        ok(mu && !mu.ok, 'markUploaded 被拒绝', JSON.stringify(mu));
        const pc = await env.sendExternal({ action: 'publishCompleted', rowNum: 121 });
        await tick(200);
        ok(pc && pc.deprecated, 'publishCompleted 标记为废弃');
        ok(env.createdUrls.length === 1, `队列未推进（开页 ${env.createdUrls.length}）`);
    }

    // ---------- 场景：未完成任务不可覆盖 ----------
    console.log('\n【16】已有未完成任务 → 新建被拒（无 force 绕过）');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [131, 132] });
        await tick(250);
        const again = await env.sendExternal({ action: 'openBatchPublish', rows: [141] });
        ok(again && !again.ok, '重复创建被拒', JSON.stringify(again));
        const forced = await env.sendExternal({ action: 'openBatchPublish', rows: [141], force: true });
        ok(forced && !forced.ok, 'force 绕过已移除', JSON.stringify(forced));
        const t = await env.run('loadPublishTask()');
        ok(t.total === 2, '原队列保留');
    }

    // ---------- 场景：后台冷启动恢复 ----------
    console.log('\n【17】后台重启 → 恢复巡检、不重复开页、不把暂停变运行');
    {
        // 先造一个持久化任务：运行中，当前 row151/tab
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [151, 152, 153] });
        await tick(250);
        const before = JSON.parse(JSON.stringify(env.store['polo_publish_task']));

        // 同一份 storage + 标签仍在 → 新上下文载入源码 = MV3 后台被回收后重新拉起
        const env2 = createEnv({
            physAvailGiB: 10, commitFreeMiB: 8192,
            initialStore: { 'polo_publish_task': before },
            initialTabs: [{ id: before.currentTabId, url: 'https://post.alibaba.com/product/publish?row=151&task=' + before.taskId }]
        });
        await tick(500);
        const t2 = await env2.run('loadPublishTask()');
        ok(t2 && t2.currentRow === 151 && t2.state === 'running', '任务与当前行恢复');
        ok(env2.createdUrls.length === 0, `恢复未重复开页（实际 ${env2.createdUrls.length}）`);
        ok(env2.alarms['publishTick'] !== undefined, '巡检 alarm 已重建');
        ok(before.batchFilled === t2.batchFilled, '批次计数保持一致');

        // 暂停态恢复不应变运行
        const pausedTask = Object.assign({}, before, { state: 'paused', pauseReason: 'manual', pauseDetail: 'x' });
        const env3 = createEnv({
            physAvailGiB: 10, commitFreeMiB: 8192,
            initialStore: { 'polo_publish_task': JSON.parse(JSON.stringify(pausedTask)) }
        });
        await tick(400);
        const t3 = await env3.run('loadPublishTask()');
        ok(t3.state === 'paused' && t3.pauseReason === 'manual', '暂停态恢复后仍是暂停');
        ok(env3.createdUrls.length === 0, '暂停恢复不开页');
    }

    // ---------- 场景：单行重试 / 跳过 ----------
    console.log('\n【18】单行重试：运行中拒绝；卡住态允许且受资源/页面/批次闸门约束');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [161, 162] });
        await tick(250);
        // 运行中重试 → 拒绝
        const rRunning = await env.sendExternal({ action: 'retryPublishRow' });
        ok(rRunning && !rRunning.ok, '运行中重试被拒绝', JSON.stringify(rRunning));
        const before = env.createdUrls.length;

        // 模拟标签被关闭 → 进入可重试的暂停态
        const t0 = await env.run('loadPublishTask()');
        for (const f of env.L.onRemoved) f(t0.currentTabId);
        await tick(250);
        const st1 = await env.sendExternal({ action: 'getPublishState' });
        ok(st1.pauseReason === 'tabClosed', `进入 tabClosed（实际 ${st1.pauseReason}）`);
        const rt = await env.sendExternal({ action: 'retryPublishRow' });
        await tick(200);
        ok(rt && rt.ok && rt.row === 161, `卡住态可重试（实际 ${JSON.stringify(rt)}）`);
        ok(env.createdUrls.length === before + 1, '重试开了一页');
        const t1 = await env.run('loadPublishTask()');
        ok(t1.batchFilled === 1, `重试计入新批次（本批已开 ${t1.batchFilled}）`);

        const sk = await env.sendExternal({ action: 'skipPublishRow' });
        await tick(250);
        const st2 = await env.sendExternal({ action: 'getPublishState' });
        ok(sk && sk.ok && sk.row === 161, '明确跳过当前行');
        ok(st2.remaining === 1, `跳过推进（剩 ${st2.remaining}）`);
    }

    // ---------- 本轮验收反馈新增：重试不得绕过闸门 ----------
    console.log('\n【19】重试绕过闸门 → 低内存 / 60 页 / 批次上限 均拒绝');
    {
        // 低内存
        const envA = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await envA.sendExternal({ action: 'openBatchPublish', rows: [201, 202] });
        await tick(250);
        const tA = await envA.run('loadPublishTask()');
        for (const f of envA.L.onRemoved) f(tA.currentTabId);
        await tick(250);
        envA.commitFreeMiBSet = 120; // 无法改已建 env，改用下面重建
        // 直接构造：暂停态 + 低提交余量
        const envA2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 120 });
        await envA2.sendExternal({ action: 'openBatchPublish', rows: [203, 204] });
        await tick(250);
        const tA2 = await envA2.run('loadPublishTask()');
        for (const f of envA2.L.onRemoved) f(tA2.currentTabId);
        await tick(250);
        // 让下一次采样用低余量（资源已被闸门拦截，重试也必须被拦）
        const createdA = envA2.createdUrls.length;
        const rtA = await envA2.sendExternal({ action: 'retryPublishRow' });
        await tick(200);
        ok(rtA && !rtA.ok, `低提交余量下重试被拒绝（实际 ${JSON.stringify(rtA)}）`);
        ok(envA2.createdUrls.length === createdA, '低余量下重试未开页');

        // 60 个目标页面
        const envB = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await envB.sendExternal({ action: 'openBatchPublish', rows: [211, 212] });
        await tick(250);
        const tB = await envB.run('loadPublishTask()');
        for (const f of envB.L.onRemoved) f(tB.currentTabId);
        await tick(250);
        // 补足到 60 个目标页
        for (let i = 0; i < 60; i++) envB.tabs.push({ id: 5000 + i, url: 'https://post.alibaba.com/product/publish?row=' + (700 + i) });
        const createdB = envB.createdUrls.length;
        const rtB = await envB.sendExternal({ action: 'retryPublishRow' });
        await tick(200);
        ok(rtB && !rtB.ok, `60 页下重试被拒绝（实际 ${JSON.stringify(rtB)}）`);
        ok(envB.createdUrls.length === createdB, '60 页下重试未开页');

        // 批次已开数达上限：新语义下「异常行带入下一批」，重试应成功并重置批次
        const envC = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await envC.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 1 } });
        await envC.sendExternal({ action: 'openBatchPublish', rows: [221, 222] });
        await tick(250);
        const tC = await envC.run('loadPublishTask()');
        for (const f of envC.L.onRemoved) f(tC.currentTabId);
        await tick(250);
        const createdC = envC.createdUrls.length;
        const rtC = await envC.sendExternal({ action: 'retryPublishRow' });
        await tick(250);
        ok(rtC && rtC.ok, `批次已达上限时仍可重试（新语义：带入下一批）（实际 ${JSON.stringify(rtC)}）`);
        ok(envC.createdUrls.length === createdC + 1, '重试开了一页');
        const tC2 = await envC.run('loadPublishTask()');
        ok(tC2.batchFilled === 1, `重试重置并计入新批次（实际 ${tC2.batchFilled}）`);
        ok(tC2.remaining.join(',') === '221,222', `异常行保留（实际 ${tC2.remaining.join(',')}）`);
    }

    // ---------- 并发新建任务 ----------
    console.log('\n【20】并发 openBatchPublish → 只允许一次成功');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        const [r1, r2] = await Promise.all([
            env.sendExternal({ action: 'openBatchPublish', rows: [2, 3] }),
            env.sendExternal({ action: 'openBatchPublish', rows: [4, 5] })
        ]);
        await tick(300);
        const okCount = [r1, r2].filter(x => x && x.ok).length;
        ok(okCount === 1, `只有一次创建成功（实际 ${okCount}）`);
        const t = await env.run('loadPublishTask()');
        const kept = t.remaining.join(',');
        ok(kept === '2,3' || kept === '4,5', `原队列完整保留其一（实际 ${kept}）`);
        ok(t.total === 2, '未被覆盖成混合队列');
    }

    // ---------- 旧任务读新文件 ----------
    console.log('\n【21】旧任务读取新文件数据 → 必须失败，不回退当前文件');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        env.store['B__product__row2'] = { row: 2, title_en: 'B 文件的产品' };
        // 任务绑定空文件名（''）
        await env.sendExternal({ action: 'openBatchPublish', rows: [2, 3] });
        await tick(250);
        const t0 = await env.run('loadPublishTask()');
        // 切到 B 文件
        await env.sendExternal({ action: 'setCurrentFilename', filename: 'B.xlsx' });
        await tick(300);
        const r = await env.sendExternal({ action: 'getProductByRow', rowNum: 2, taskId: t0.taskId });
        ok(r && !r.ok, `旧任务读新文件被拒绝（实际 ${JSON.stringify(r)}）`);
        const rBad = await env.sendExternal({ action: 'getProductByRow', rowNum: 2, taskId: 'pt_not_exist' });
        ok(rBad && !rBad.ok, '不存在的 taskId 被拒绝');
    }

    // ---------- 文件切换后继续/重试 ----------
    console.log('\n【22】文件切换后：继续 / 重试 一律拒绝并保持 fileSwitch');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [231, 232] });
        await tick(250);
        const t0 = await env.run('loadPublishTask()');
        // 先让当前行完成（清掉 currentRow），再切文件
        await env.sendInternal({ action: 'publishFilled', row: 231, taskId: t0.taskId }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(250);
        await env.sendExternal({ action: 'setCurrentFilename', filename: 'B2.xlsx' });
        await tick(300);
        const created = env.createdUrls.length;
        const res = await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(res && !res.ok, `切文件后继续被拒（实际 ${JSON.stringify(res)}）`);
        ok(env.createdUrls.length === created, '未开新页');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.pauseReason === 'fileSwitch', `保持 fileSwitch（实际 ${st.pauseReason}）`);

        // 空文件名任务 → 有文件名：同样受闸门约束
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env2.sendExternal({ action: 'openBatchPublish', rows: [241, 242] });
        await tick(250);
        const t1 = await env2.run('loadPublishTask()');
        for (const f of env2.L.onRemoved) f(t1.currentTabId);
        await tick(250);
        await env2.sendExternal({ action: 'setCurrentFilename', filename: 'C.xlsx' });
        await tick(300);
        const created2 = env2.createdUrls.length;
        const rt = await env2.sendExternal({ action: 'retryPublishRow' });
        await tick(200);
        ok(rt && !rt.ok, `空文件名任务切文件后重试被拒（实际 ${JSON.stringify(rt)}）`);
        ok(env2.createdUrls.length === created2, '未开新页');
    }

    // ---------- 同名同步不误暂停 ----------
    console.log('\n【23】同名 setCurrentFilename → 不暂停任务');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [251, 252] });
        await tick(250);
        const r = await env.sendExternal({ action: 'setCurrentFilename', filename: '' }); // 与当前同名（都是 ''）
        await tick(250);
        ok(r && r.ok && r.unchanged, '同名同步被识别为 unchanged', JSON.stringify(r));
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'running', `任务未被误暂停（实际 ${st.state}）`);
    }

    // ---------- 检查期间停止 ----------
    console.log('\n【24】资源检查期间收到停止 → 不再创建新页');
    {
        // 让提交端点挂起，使 processPublishQueue 卡在等待；期间发停止
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, commitFetchHang: true });
        const p = env.sendExternal({ action: 'openBatchPublish', rows: [261, 262] });
        await tick(60);                         // 让它进入资源检查
        env.sendExternal({ action: 'pausePublishQueue' });   // 立即置停止闸门
        await tick(3800);                       // 等资源检查的 3 秒超时走完
        const t = await env.run('loadPublishTask()');
        ok(t && t.state === 'paused', `已暂停（实际 ${t && t.state}）`);
        ok(env.createdUrls.length === 0, `停止后未创建新页（实际 ${env.createdUrls.length}）`);
        await p.catch(() => {});
    }

    // ---------- 批次大小设置生效 ----------
    console.log('\n【25】批次大小设置对当前（暂停）任务生效，运行中不可改');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 50 } });
        await env.sendExternal({ action: 'openBatchPublish', rows: [271, 272, 273, 274] });
        await tick(250);
        // 运行中：设置不改变当前任务批次
        const s1 = await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 3 } });
        ok(s1 && s1.ok && s1.settings.batchSize === 3, '设置对象已更新为 3');
        let t = await env.run('loadPublishTask()');
        ok(t.batchSize === 50, `运行中任务批次不变（实际 ${t.batchSize}）`);
        // 暂停 → 设置同步到任务
        await env.sendExternal({ action: 'pausePublishQueue' });
        await tick(250);
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 3 } });
        await tick(250);
        t = await env.run('loadPublishTask()');
        ok(t.batchSize === 3, `暂停后任务批次已同步为 3（实际 ${t.batchSize}）`);
        // 继续后按 3 款分批
        const createdBefore = env.createdUrls.length;
        await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(200);
        await driveFills(env, 3);
        await tick(250);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.batchSize === 3, `继续后仍为 3（实际 ${st.batchSize}）`);
        ok(env.createdUrls.length <= createdBefore + 3, `一批不超过 3 页（实际新增 ${env.createdUrls.length - createdBefore}）`);
    }

    // ---------- 停止代次：继续/重试期间到达的停止不得被抹掉 ----------
    console.log('\n【26】继续/重试期间收到停止 → 不得创建新页（停止代次）');
    {
        // 重试路径：资源检查期间收到停止
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, commitFetchDelayMs: 250 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [301, 302] });
        await tick(400);
        const t0 = await env.run('loadPublishTask()');
        for (const f of env.L.onRemoved) f(t0.currentTabId);   // 制造可重试态
        await tick(250);
        const createdBefore = env.createdUrls.length;
        env.run('memSampleCache = { at: 0, value: null }');    // 确保重试的资源检查真的走网络
        const pRetry = env.sendExternal({ action: 'retryPublishRow' });
        await tick(60);
        await env.sendExternal({ action: 'pausePublishQueue' });  // 检查期间停止
        const rt = await pRetry;
        await tick(400);
        ok(rt && !rt.ok, `重试期间停止 → 重试被拒（实际 ${JSON.stringify(rt)}）`);
        ok(env.createdUrls.length === createdBefore, `重试期间停止未创建新页（实际新增 ${env.createdUrls.length - createdBefore}）`);
        const stR = await env.sendExternal({ action: 'getPublishState' });
        ok(stR.state === 'paused', '保持暂停');

        // 继续路径：资源检查期间收到停止
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, commitFetchDelayMs: 250 });
        await env2.sendExternal({ action: 'openBatchPublish', rows: [311, 312] });
        await tick(400);
        const t1 = await env2.run('loadPublishTask()');
        await env2.sendInternal({ action: 'publishFilled', row: 311, taskId: t1.taskId }, { tab: { id: t1.currentTabId }, frameId: 0 });
        await tick(300);
        await env2.sendExternal({ action: 'pausePublishQueue' });
        await tick(300);
        const created2 = env2.createdUrls.length;
        env2.run('memSampleCache = { at: 0, value: null }');
        const pResume = env2.sendExternal({ action: 'resumePublishQueue' });
        await tick(60);
        await env2.sendExternal({ action: 'pausePublishQueue' });  // 检查期间停止
        const rs = await pResume;
        await tick(400);
        ok(rs && !rs.ok, `继续期间停止 → 继续被拒（实际 ${JSON.stringify(rs)}）`);
        ok(env2.createdUrls.length === created2, `继续期间停止未创建新页（实际新增 ${env2.createdUrls.length - created2}）`);

        // 普通推进路径
        const env3 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, commitFetchDelayMs: 250 });
        const p3 = env3.sendExternal({ action: 'openBatchPublish', rows: [321, 322] });
        await tick(60);
        await env3.sendExternal({ action: 'pausePublishQueue' });
        await p3;
        await tick(500);
        ok(env3.createdUrls.length === 0, `普通推进期间停止未创建新页（实际 ${env3.createdUrls.length}）`);
    }

    console.log('\n【27】旧停止可被「明确继续」解除；新停止不能被抹掉；重复停止幂等');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [331, 332, 333] });
        await tick(300);
        let t0 = await env.run('loadPublishTask()');
        // 第 1 款填完 → 自动开第 2 页
        await env.sendInternal({ action: 'publishFilled', row: 331, taskId: t0.taskId }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(300);
        t0 = await env.run('loadPublishTask()');
        ok(env.createdUrls.length === 2 && t0.currentRow === 332, `第 2 款在填（开页 ${env.createdUrls.length} / 当前 ${t0.currentRow}）`);

        await env.sendExternal({ action: 'pausePublishQueue' });
        await tick(300);
        // 手动停止时当前行仍有效 → 「继续」只恢复等待，不重复开页
        const created = env.createdUrls.length;
        const r1 = await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(r1 && r1.ok, '手动停止可被明确继续解除', JSON.stringify(r1));
        ok(env.createdUrls.length === created, '当前行仍有效时继续 → 只恢复等待，不重复开页');
        const st1 = await env.sendExternal({ action: 'getPublishState' });
        ok(st1.state === 'running', '状态回到 running');

        // 当前行完成后自动推进
        await env.sendInternal({ action: 'publishFilled', row: 332, taskId: t0.taskId }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(300);
        ok(env.createdUrls.length === created + 1, `当前行完成后自动开下一页（开页 ${env.createdUrls.length}）`);

        // 重复停止不应报错
        await env.sendExternal({ action: 'pausePublishQueue' });
        await env.sendExternal({ action: 'pausePublishQueue' });
        await tick(300);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused', '重复停止后仍为暂停');
        const r2 = await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(200);
        ok(r2 && r2.ok, '再次继续成功（幂等）');
    }

    console.log('\n【28】批次最后一款异常 → 重试可恢复（资源允许）／资源不足拒绝');
    {
        // 批次 3 的第 3 款超时/关页 → 资源充足可重试
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 3 } });
        await env.sendExternal({ action: 'openBatchPublish', rows: [341, 342, 343, 344] });
        await tick(300);
        await driveFills(env, 2);                 // 前两款填完
        await tick(300);
        let t = await env.run('loadPublishTask()');
        ok(t.batchFilled === 3 && t.currentRow === 343, `第 3 款在填且本批已开 3（实际 ${t.batchFilled}/${t.currentRow}）`);
        for (const f of env.L.onRemoved) f(t.currentTabId);   // 第 3 款标签被关
        await tick(300);
        const createdBefore = env.createdUrls.length;
        const rt = await env.sendExternal({ action: 'retryPublishRow' });
        await tick(300);
        ok(rt && rt.ok && rt.row === 343, `批次最后一款可重试（实际 ${JSON.stringify(rt)}）`);
        ok(env.createdUrls.length === createdBefore + 1, '重试开了一页');
        t = await env.run('loadPublishTask()');
        ok(t.batchFilled === 1, `重试计入新批次（本批已开 ${t.batchFilled}）`);
        ok(t.remaining.join(',') === '343,344', `异常行保留在队列（实际 ${t.remaining.join(',')}）`);
        ok(t.filledCount === 2, `已填记录未重复入账（实际 ${t.filledCount}）`);
        // 旧标签迟到完成不得推进新重试的当前标签
        const late = await env.sendInternal({ action: 'publishFilled', row: 343, taskId: t.taskId },
            { tab: { id: 999999 }, frameId: 0 });
        ok(late && !late.ok, '旧标签迟到完成被拒绝', JSON.stringify(late));
        const t2 = await env.run('loadPublishTask()');
        ok(t2.filledCount === 2 && t2.currentRow === 343, '新当前标签未被旧消息推进');

        // 资源不足 → 重试拒绝
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env2.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 3 } });
        await env2.sendExternal({ action: 'openBatchPublish', rows: [351, 352, 353] });
        await tick(300);
        const t3 = await env2.run('loadPublishTask()');
        for (const f of env2.L.onRemoved) f(t3.currentTabId);
        await tick(300);
        // 把提交余量压到下限以下（换一个低余量环境沿用同一任务较难，这里直接用 60 页上限）
        for (let i = 0; i < 60; i++) env2.tabs.push({ id: 8000 + i, url: 'https://post.alibaba.com/product/publish?row=' + (600 + i) });
        const created3 = env2.createdUrls.length;
        const rt3 = await env2.sendExternal({ action: 'retryPublishRow' });
        await tick(300);
        ok(rt3 && !rt3.ok, `资源/页面上限不足时重试拒绝（实际 ${JSON.stringify(rt3)}）`);
        ok(env2.createdUrls.length === created3, '资源不足时未开页');

        // 默认 50 款的第 50 款同理
        const env4 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env4.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 50 } });
        const rows4 = Array.from({ length: 60 }, (_, i) => 400 + i);
        await env4.sendExternal({ action: 'openBatchPublish', rows: rows4 });
        await tick(300);
        await driveFills(env4, 49);
        await tick(300);
        const t4 = await env4.run('loadPublishTask()');
        ok(t4.batchFilled === 50 && t4.currentRow === 449, `第 50 款在填（实际 ${t4.batchFilled}/${t4.currentRow}）`);
        for (const f of env4.L.onRemoved) f(t4.currentTabId);
        await tick(300);
        const c4 = env4.createdUrls.length;
        const rt4 = await env4.sendExternal({ action: 'retryPublishRow' });
        await tick(300);
        ok(rt4 && rt4.ok, `默认 50 款的第 50 款可重试（实际 ${JSON.stringify(rt4)}）`);
        ok(env4.createdUrls.length === c4 + 1, '第 50 款重试开了一页');
    }

    console.log('\n【29】失效页面不允许靠「继续」空等');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [361, 362] });
        await tick(300);
        const t0 = await env.run('loadPublishTask()');
        for (const f of env.L.onRemoved) f(t0.currentTabId);
        await tick(300);
        const created = env.createdUrls.length;
        const res = await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(res && !res.ok, `失效当前行时「继续」被拒并给出指引（实际 ${JSON.stringify(res)}）`);
        ok(/重试当前行/.test(res.message || ''), '拒绝信息指向「重试当前行」');
        ok(env.createdUrls.length === created, '未开新页');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused' && st.pauseReason === 'tabClosed', '仍保持 tabClosed');
    }
    // ---------- 排队中的继续/重试 + 后到达的停止 ----------
    console.log('\n【30】锁被占用 → 继续请求 → 停止请求 → 释放锁 → 不得开页');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [501, 502, 503] });
        await tick(300);
        const t0 = await env.run('loadPublishTask()');
        await env.sendInternal({ action: 'publishFilled', row: 501, taskId: t0.taskId }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(300);
        await env.sendExternal({ action: 'pausePublishQueue' });
        await tick(300);
        const created = env.createdUrls.length;

        // 占住互斥链
        env.run('withPublishLock(() => new Promise(r => setTimeout(r, 500)))');
        await tick(30);
        const pResume = env.sendExternal({ action: 'resumePublishQueue' });   // 进入队列
        await tick(30);
        await env.sendExternal({ action: 'pausePublishQueue' });              // 排队期间新停止
        const rs = await pResume;
        await tick(400);
        ok(rs && !rs.ok, `排队期间新停止 → 继续被拒（实际 ${JSON.stringify(rs)}）`);
        ok(env.createdUrls.length === created, `未创建新页（实际新增 ${env.createdUrls.length - created}）`);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'paused', '保持暂停');
    }

    console.log('\n【31】锁被占用 → 重试请求 → 停止请求 → 释放锁 → 不得开页');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 3 } });
        await env.sendExternal({ action: 'openBatchPublish', rows: [511, 512, 513] });
        await tick(300);
        const t0 = await env.run('loadPublishTask()');
        for (const f of env.L.onRemoved) f(t0.currentTabId);   // 制造可重试态
        await tick(300);
        const created = env.createdUrls.length;

        env.run('withPublishLock(() => new Promise(r => setTimeout(r, 500)))');
        await tick(30);
        const pRetry = env.sendExternal({ action: 'retryPublishRow' });
        await tick(30);
        await env.sendExternal({ action: 'pausePublishQueue' });
        const rt = await pRetry;
        await tick(400);
        ok(rt && !rt.ok, `排队期间新停止 → 重试被拒（实际 ${JSON.stringify(rt)}）`);
        ok(env.createdUrls.length === created, `未创建新页（实际新增 ${env.createdUrls.length - created}）`);
    }

    console.log('\n【32】停止在前、明确继续在后 → 允许正常恢复');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [521, 522, 523] });
        await tick(300);
        const t0 = await env.run('loadPublishTask()');
        await env.sendInternal({ action: 'publishFilled', row: 521, taskId: t0.taskId }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(300);
        await env.sendExternal({ action: 'pausePublishQueue' });   // 停止在前
        await tick(300);
        const created = env.createdUrls.length;
        const rs = await env.sendExternal({ action: 'resumePublishQueue' });  // 明确继续在后
        await tick(400);
        ok(rs && rs.ok, `旧停止可被明确继续解除（实际 ${JSON.stringify(rs)}）`);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'running', '恢复到运行');
    }

    console.log('\n【33】无效继续/重试不得清除停止');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        // 没有任务 → 继续/重试均无效
        await env.sendExternal({ action: 'pausePublishQueue' });
        await tick(200);
        const resumeNoTask = await env.sendExternal({ action: 'resumePublishQueue' });
        ok(resumeNoTask && !resumeNoTask.ok, '无任务时继续被拒');
        const retryNoTask = await env.sendExternal({ action: 'retryPublishRow' });
        ok(retryNoTask && !retryNoTask.ok, '无任务时重试被拒');
        // 内部状态：停止仍生效（用后续合法开页验证）
        await env.sendExternal({ action: 'openBatchPublish', rows: [531] });
        await tick(400);
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'running' && env.createdUrls.length === 1, '明确的新建任务可正常开页（旧停止被新意图解除）');
    }

    console.log('\n【34】重试被资源拒绝 → 保留行失效事实 → 资源恢复后可重试');
    {
        // 提交余量 120MiB：资源被拒
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 120 });
        await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 3 } });
        await env.sendExternal({ action: 'openBatchPublish', rows: [541, 542, 543] });
        await tick(400);
        // 资源不足 → 可能一开始就没开页；构造一个"行已失效"的任务状态
        env.store['polo_publish_task'] = {
            taskId: 'pt_manual_fail', fileKey: '', total: 3, remaining: [541, 542, 543],
            filledCount: 0, filledRows: [], batchSize: 3, batchFilled: 1, batchFilledDone: 0,
            pageLimit: 60, rowTimeoutMs: 600000, state: 'paused',
            pauseReason: 'rowTimeout', pauseDetail: '第 541 行填写超时',
            currentRow: 541, currentTabId: 999, currentStartedAt: Date.now() - 700000,
            currentRowRetries: 0, currentRowFailure: 'rowTimeout', resourceBlockDetail: '',
            skippedRows: [], startedAt: Date.now()
        };
        const created0 = env.createdUrls.length;
        const rt1 = await env.sendExternal({ action: 'retryPublishRow' });
        await tick(300);
        ok(rt1 && !rt1.ok, `资源不足时重试被拒（实际 ${JSON.stringify(rt1)}）`);
        const st1 = await env.sendExternal({ action: 'getPublishState' });
        ok(st1.rowRetryable === true, `行失效事实被保留（rowRetryable=${st1.rowRetryable}）`);
        ok(st1.currentRowFailure === 'rowTimeout', `currentRowFailure 仍为 rowTimeout（实际 ${st1.currentRowFailure}）`);
        ok(env.createdUrls.length === created0, '未开页');

        // 资源恢复 → 重试成功
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        env2.store['polo_publish_task'] = JSON.parse(JSON.stringify(env.store['polo_publish_task']));
        env2.tabs.push({ id: 999, url: 'https://post.alibaba.com/product/publish?row=541&task=pt_manual_fail' });
        // 让新上下文能读到该任务：重新载入源码（等同后台重启）
        const env3 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, initialStore: { 'polo_publish_task': JSON.parse(JSON.stringify(env.store['polo_publish_task'])) } });
        const rt2 = await env3.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(rt2 && !rt2.ok, `失效行时「继续」被拒并指引重试（实际 ${JSON.stringify(rt2)}）`);
        const rt3 = await env3.sendExternal({ action: 'retryPublishRow' });
        await tick(300);
        ok(rt3 && rt3.ok, `资源恢复后可重试原行（实际 ${JSON.stringify(rt3)}）`);
        ok(env3.createdUrls.length === 1, '重试开了一页');
        const st3 = await env3.sendExternal({ action: 'getPublishState' });
        ok(st3.currentRowFailure === '', `失效状态已清除（实际 "${st3.currentRowFailure}"）`);
        ok(st3.rowRetries === 1, `重试次数只在实际开页后增加（实际 ${st3.rowRetries}）`);

        // 60 页上限拒绝后仍可重试
        const env4 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, initialStore: { 'polo_publish_task': JSON.parse(JSON.stringify(env.store['polo_publish_task'])) } });
        for (let i = 0; i < 60; i++) env4.tabs.push({ id: 9000 + i, url: 'https://post.alibaba.com/product/publish?row=' + (500 + i) });
        const rt4 = await env4.sendExternal({ action: 'retryPublishRow' });
        await tick(300);
        ok(rt4 && !rt4.ok, `60 页上限时重试被拒（实际 ${JSON.stringify(rt4)}）`);
        const st4 = await env4.sendExternal({ action: 'getPublishState' });
        ok(st4.rowRetryable === true, '60 页拒绝后行失效事实仍保留');
    }
    // ---------- 换色与发品共用的内存闸门 ----------
    console.log('\n【35】getMemoryGate（换色与发品共用同一套判断）');
    {
        // 物理充足但提交余量仅 120MiB → 不允许
        const envA = createEnv({ physAvailGiB: 10, commitFreeMiB: 120 });
        const gA = await envA.sendExternal({ action: 'getMemoryGate' });
        ok(gA && gA.ok && gA.allowed === false, `提交余量 120MiB → 不允许（实际 ${JSON.stringify(gA && gA.allowed)}）`);
        ok(/提交剩余/.test(gA.reasonText || ''), `原因说明提交剩余（实际 ${gA.reasonText}）`);
        ok(gA.physAvailableMB > 9000, `物理内存仍充足（${gA.physAvailableMB}MiB）`);

        // 服务不可用 → 不允许（监测失败即暂停，不静默放行）
        const envB = createEnv({ physAvailGiB: 10, commitFetchFails: true });
        const gB = await envB.sendExternal({ action: 'getMemoryGate' });
        ok(gB && gB.allowed === false, '本地服务不可用 → 不允许');
        ok(/提交额度监测不可用/.test(gB.reasonText || ''), `原因标为监测不可用（实际 ${gB.reasonText}）`);

        // 物理低于阈值 → 不允许
        const envC = createEnv({ physAvailGiB: 1, commitFreeMiB: 8192 });
        const gC = await envC.sendExternal({ action: 'getMemoryGate' });
        ok(gC && gC.allowed === false, '物理低于阈值 → 不允许');
        ok(/可用物理内存/.test(gC.reasonText || ''), `原因说明物理内存（实际 ${gC.reasonText}）`);

        // 提交使用率 ≥ 90% → 不允许
        const envD = createEnv({ commitLimitGiB: 64, commitFreeMiB: 8192, physAvailGiB: 10 });
        envD.memOverrideUsedPct = null;
        const gD0 = await envD.sendExternal({ action: 'getMemoryGate' });
        ok(gD0 && gD0.allowed === true, `资源充足 → 允许（实际 ${JSON.stringify(gD0 && gD0.allowed)}）`);
        // 使用率 95%：用大 limit 让"提交剩余"规则不先命中（free=5% 且 > 4096MiB）
        const envE = createEnv({ physAvailGiB: 10, commitLimitGiB: 100, commitFreeMiB: 5 * 1024 });
        const gE = await envE.sendExternal({ action: 'getMemoryGate' });
        ok(gE && gE.allowed === false, `提交使用率 95% → 不允许（usedPct=${gE && gE.commitUsedPct}）`);
        ok(/提交已用/.test(gE.reasonText || ''), `原因说明使用率（实际 ${gE && gE.reasonText}）`);

        // 恢复后允许
        const envF = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        const gF = await envF.sendExternal({ action: 'getMemoryGate', forceRefresh: true });
        ok(gF && gF.allowed === true, '资源恢复 → 允许继续');
        ok(typeof gF.sampledAt === 'number' && gF.sampledAt > 0, '返回采样时间');
    }

    // ---------- 换色完成链路：batchId 由执行任务自带 ----------
    console.log('\n【36】换色完成链路：batchId 由执行任务自带返回，后台校验并原样传播');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        // 模拟已有豆包标签，走 findDoubaoTab 分支（该分支会清 pendingColorTask）
        env.tabs.push({ id: 7777, url: 'https://www.doubao.com/chat/xxx' });

        const r = await env.sendExternal({ action: 'startColorChange', task: { imagePath: 'x.jpg', prompt: 'p', rowNum: 412, batchId: 'cb_CHAIN' } });
        await tick(2600);
        ok(env.run('(activeColorExec && activeColorExec.batchId)') === 'cb_CHAIN' || env.store['polo_active_color_exec'].batchId === 'cb_CHAIN',
            `任务已启动并持久化执行身份（实际 ${JSON.stringify(env.store['polo_active_color_exec'])}）`);
        ok(env.store['polo_pending_color_task'] === undefined, '待启动记录(storage)已被清空 —— 模拟真实运行时状态');

        // content 完成：自带 batchId
        const c1 = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: { success: true }, batchId: 'cb_CHAIN' }, { tab: { id: 7777 } });
        await tick(150);
        ok(c1 && c1.ok, '正确标识的完成消息被接受');
        const ev = env.store['color_task_complete_event'];
        ok(ev && ev.rowNum === 412 && ev.batchId === 'cb_CHAIN', `完成事件原样带上 batchId（实际 ${JSON.stringify(ev && ev.batchId)}）`);

        // content 完成：旧任务标识 → 拒绝，且不覆盖事件
        const c2 = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: {}, batchId: 'cb_OLD' }, { tab: { id: 7777 } });
        await tick(150);
        ok(c2 && c2.ok === false, `旧任务标识被后台拒绝（实际 ${JSON.stringify(c2)}）`);
        ok(env.store['color_task_complete_event'].batchId === 'cb_CHAIN', '拒绝时不覆盖已有完成事件');

        // content 完成：缺标识 → 批量任务下同样拒绝（不能冒充）
        const c3 = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 415, results: {} }, { tab: { id: 7777 } });
        await tick(150);
        ok(c3 && c3.ok === false, `批量任务下标缺失被拒绝（实际 ${JSON.stringify(c3)}）`);
        ok(env.store['color_task_complete_event'].rowNum === 412, '缺标识消息未写入完成事件');

        // 后端记录：缺标识消息也不会误用其它 pending 任务的标识
        ok(env.store['color_task_complete_event'].batchId === 'cb_CHAIN', '事件标识未被污染');

        // 单款任务（无 batchId）：activeBatchId 为空，不参与批量校验
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        env2.tabs.push({ id: 8888, url: 'https://www.doubao.com/chat/yyy' });
        await env2.sendExternal({ action: 'startColorChange', task: { imagePath: 'y.jpg', prompt: 'p', rowNum: 900 } });
        await tick(1300);
        ok(env2.run('(activeColorExec && activeColorExec.batchId) || null') === null, '单款任务不设批量标识');
        const c4 = await env2.sendInternal({ action: 'colorTaskComplete', rowNum: 900, results: {} }, { tab: { id: 8888 } });
        await tick(150);
        ok(c4 && c4.ok, '单款任务完成仍可处理（语义与批量分开）');
    }

    // ---------- 换色执行身份：MV3 冷启动后仍有效 ----------
    console.log('\n【37】冷启动后身份校验：旧/缺标识不得覆盖已保存的正确完成事件');
    {
        const EXEC = { batchId: 'CURRENT', rowNum: 412, source: 'batch', startedAt: Date.now() };
        const EVT = { rowNum: 412, timestamp: Date.now() - 1000, results: {}, batchId: 'CURRENT' };
        // 模拟：上一轮已派发（写入持久化身份），worker 被回收后重新拉起
        const env = createEnv({
            physAvailGiB: 10, commitFreeMiB: 8192,
            initialStore: { 'polo_active_color_exec': EXEC, 'color_task_complete_event': EVT }
        });
        await tick(200);
        await env.run('getActiveColorExec()');   // 冷启动恢复路径（含惰性加载）
        ok(env.store['polo_active_color_exec'].batchId === 'CURRENT', '冷启动时执行身份记录存在');
        ok(env.run('activeColorExec && activeColorExec.batchId') === 'CURRENT', '冷启动后身份已恢复');

        // 旧标识迟到 → 拒绝且不覆盖
        const o = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: {}, batchId: 'OLD' }, { tab: { id: 1 } });
        await tick(150);
        ok(o && o.ok === false, `旧标识被拒绝（实际 ${JSON.stringify(o)}）`);
        ok(env.store['color_task_complete_event'].batchId === 'CURRENT', '已保存的正确事件未被覆盖');

        // 缺标识 → 拒绝且不覆盖
        const n = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: {} }, { tab: { id: 1 } });
        await tick(150);
        ok(n && n.ok === false, '缺标识被拒绝');
        ok(env.store['color_task_complete_event'].batchId === 'CURRENT', '缺标识不覆盖已保存事件');

        // 行号不符 → 拒绝
        const r = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 999, results: {}, batchId: 'CURRENT' }, { tab: { id: 1 } });
        await tick(150);
        ok(r && r.ok === false, '行号不符被拒绝');

        // 正确标识 → 接受并更新事件
        const g = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: { success: true }, batchId: 'CURRENT' }, { tab: { id: 1 } });
        await tick(150);
        ok(g && g.ok === true, '正确标识被接受');
        ok(env.store['color_task_complete_event'].timestamp > EVT.timestamp, '完成事件被正确更新');

        // 无身份记录 → 拒绝（不静默当成单款任务）
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        const noExec = await env2.sendInternal({ action: 'colorTaskComplete', rowNum: 500, results: {} }, { tab: { id: 1 } });
        await tick(150);
        ok(noExec && noExec.ok === false, '无执行身份记录时拒绝（不静默当单款）');
        ok(env2.store['color_task_complete_event'] === undefined, '不写入完成事件');

        // 单款任务也写身份记录
        const env3 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        env3.tabs.push({ id: 6666, url: 'https://www.doubao.com/chat/zzz' });
        await env3.sendExternal({ action: 'startColorChange', task: { imagePath: 'z.jpg', prompt: 'p', rowNum: 600 } });
        await tick(2600);
        const singleExec = env3.store['polo_active_color_exec'];
        ok(singleExec && singleExec.source === 'single' && singleExec.rowNum === 600, `单款也有执行记录（实际 ${JSON.stringify(singleExec)}）`);
    }

    // ---------- 汇总 ----------
    console.log('\n' + '='.repeat(50));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(50));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('测试运行异常:', e && e.stack || e);
    process.exit(1);
});
