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
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'manifest.json'), 'utf8'));
    if (opts.storagePermissions) manifest.permissions = opts.storagePermissions;
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
            // 可选真实容量规则：按 Chrome local 的键名 + JSON 大小计费。
            // unlimitedStorage 免除该配额；写入失败不能部分覆盖旧数据。
            if (opts.storageQuotaBytes && !manifest.permissions.includes('unlimitedStorage')) {
                const next = Object.assign({}, store, obj);
                const bytes = Object.entries(next).reduce((n, [k, v]) => n + require('buffer').Buffer.byteLength(k) + require('buffer').Buffer.byteLength(JSON.stringify(v)), 0);
                if (bytes > opts.storageQuotaBytes) {
                    setTimeout(() => {
                        chrome.runtime.lastError = { message: 'Resource::kQuotaBytes quota exceeded' };
                        try { if (cb) cb(); } finally { chrome.runtime.lastError = null; }
                    }, 0);
                    return;
                }
            }
            for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k]));
            if (cb) setTimeout(cb, 0);
        },
        remove(keys, cb) {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete store[k];
            if (cb) setTimeout(cb, 0);
        }
    };

    const sentMessages = [];
    const chrome = {
        runtime: {
            id: 'test-extension-id',
            lastError: null,
            getManifest: () => manifest,
            onMessage: { addListener: f => L.onMessage.push(f) },
            onMessageExternal: { addListener: f => L.onMessageExternal.push(f) },
            onConnectExternal: { addListener: f => L.onConnect.push(f) },
            onInstalled: { addListener: f => L.onInstalled.push(f) },
            onStartup: { addListener: f => L.onStartup.push(f) },
            // 兼容两种调用签名：(msg, cb) 与 (extensionId, msg, cb)
            sendMessage: (a, b, c) => {
                const msg = (b && typeof b === 'object') ? b : a;
                const cb = typeof c === 'function' ? c : (typeof b === 'function' ? b : null);
                sentMessages.push(msg);
                if (cb) cb({ ok: true });
            },
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
            sendMessage: async () => (opts.tabsSendMessageResponse === undefined ? undefined : opts.tabsSendMessageResponse),
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
        URL: require('url').URL, URLSearchParams, AbortController, Blob: class {}, TextDecoder,
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

    return { ctx, run, store, sentMessages, tabs, createdUrls, alarms, L, sendInternal, sendExternal };
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

    console.log('\n【4】手动暂停即停止当前产品填入；继续重新发当前产品');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env.sendExternal({ action: 'openBatchPublish', rows: [11, 12, 13] });
        await tick(250);
        const t0 = await env.run('loadPublishTask()');
        const curTab = t0.currentTabId, curRow = t0.currentRow;
        ok(curRow === 11 && env.createdUrls.length === 1, '当前 row11 / 1 页');
        // 手动暂停：关闭当前产品页
        await env.sendExternal({ action: 'pausePublishQueue' });
        // 页面已关闭，旧页面迟到的完成消息应被拒绝
        const r1 = await env.sendInternal({ action: 'publishFilled', row: 11, taskId: t0.taskId }, { tab: { id: curTab }, frameId: 0 });
        await tick(200);
        ok(!r1 || !r1.ok, '暂停关闭页面后旧页面的完成消息被拒绝', JSON.stringify(r1));
        const t1 = await env.run('loadPublishTask()');
        ok(t1.remaining.length === 3 && t1.filledCount === 0, `未入账：剩 ${t1.remaining.length} 已填 ${t1.filledCount}`);
        ok(env.createdUrls.length === 1, `仍只开 1 页（实际 ${env.createdUrls.length}）`);
        // 继续 = 当前产品重新发一遍
        await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(env.createdUrls.length === 2, `继续后重新打开当前产品 row11（实际 ${env.createdUrls.length}）`);
        ok(env.createdUrls[1].indexOf('row=11') >= 0, '继续重新发当前产品 row11');
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
    // 旧场景 7 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    // 旧场景 8 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    // 旧场景 9 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    // 旧场景 10 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

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
    // 旧场景 19 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

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
    // 旧场景 24 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    // 旧场景 25 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    // 旧场景 26 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

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
        // 手动暂停会关闭当前页；继续 = 当前产品重新发一遍
        const created = env.createdUrls.length;
        const r1 = await env.sendExternal({ action: 'resumePublishQueue' });
        await tick(300);
        ok(r1 && r1.ok, '手动停止可被明确继续解除', JSON.stringify(r1));
        ok(env.createdUrls.length === created + 1, '手动暂停后继续 → 重新打开当前产品');
        const st1 = await env.sendExternal({ action: 'getPublishState' });
        ok(st1.state === 'running', '状态回到 running');

        // 当前行完成后自动推进
        t0 = await env.run('loadPublishTask()'); await env.sendInternal({ action: 'publishFilled', row: 332, taskId: t0.taskId }, { tab: { id: t0.currentTabId }, frameId: 0 });
        await tick(300);
        ok(env.createdUrls.length === created + 2, `当前行完成后自动开下一页（开页 ${env.createdUrls.length}）`);

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

    // 旧场景 28 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    console.log('\n【29】失效页面：继续 = 重开当前行');
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
        ok(res && res.ok, `失效当前行时「继续」直接重开该行（实际 ${JSON.stringify(res)}）`);
        ok(env.createdUrls.length === created + 1, '重开了一页');
        ok(env.createdUrls[env.createdUrls.length - 1].indexOf('row=361') >= 0, '重开的是同一行 row361');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.state === 'running' && st.currentRow === 361, '继续后重新发 row361');
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

    // 旧场景 34 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    // 旧场景 35 的内存/60页/可调批次要求已撤销；替代覆盖见 test-fixed-batch-no-memory.js。

    console.log('\n【36】换色完成链路：batchId 由执行任务自带返回，后台校验并原样传播');
    {
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, tabsSendMessageResponse: { ok: true, accepted: true } });
        // 模拟已有豆包标签，走 findDoubaoTab 分支（该分支会清 pendingColorTask）
        env.tabs.push({ id: 7777, url: 'https://www.doubao.com/chat/xxx' });

        const r = await env.sendExternal({ action: 'startColorChange', task: { imagePath: 'x.jpg', prompt: 'p', rowNum: 412, batchId: 'cb_CHAIN' } });
        await tick(2600);
        ok(env.run('(activeColorExec && activeColorExec.batchId)') === 'cb_CHAIN' || env.store['polo_active_color_exec'].batchId === 'cb_CHAIN',
            `任务已启动并持久化执行身份（实际 ${JSON.stringify(env.store['polo_active_color_exec'])}）`);
        ok(env.store['polo_pending_color_task'] === undefined, '待启动记录(storage)已被清空 —— 模拟真实运行时状态');

        // content 完成：自带 batchId
        const c1 = await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: { success: true }, batchId: 'cb_CHAIN', executionId: env.store['polo_active_color_exec'].executionId }, { tab: { id: 7777 } });
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
        const c4 = await env2.sendInternal({ action: 'colorTaskComplete', rowNum: 900, executionId: env2.store['polo_active_color_exec'].executionId, results: {} }, { tab: { id: 8888 } });
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

    // ---------- 豆包 busy 拒绝必须传播到页面 ----------
    console.log('\n【38】豆包忙碌拒绝：后台必须返回 ok:false/busy，且不覆盖原执行身份');
    {
        const PREV = { batchId: 'OLD_BATCH', rowNum: 111, source: 'batch', state: 'accepted', startedAt: Date.now() };
        const env = createEnv({
            physAvailGiB: 10, commitFreeMiB: 8192,
            initialStore: { 'polo_active_color_exec': PREV },
            tabsSendMessageResponse: { ok: false, busy: true, error: '豆包正在执行上一个换色任务，未接收新任务' }
        });
        env.tabs.push({ id: 7777, url: 'https://www.doubao.com/chat/xxx' });
        const r = await env.sendExternal({ action: 'startColorChange', task: { imagePath: 'x.jpg', prompt: 'p', rowNum: 412, batchId: 'NEW_BATCH' } });
        await tick(2600);
        // 直接调用生产函数校验返回值（sendExternal 有超时兜底）
        const rr = await env.run(`openDoubaoAndStartTask({ imagePath:'x.jpg', prompt:'p', rowNum:412, batchId:'NEW_BATCH' })`);
        await tick(1500);
        ok(rr && rr.ok === false && rr.busy === true, `busy 被传播为 ok:false（实际 ${JSON.stringify(rr)}）`);
        const exec = env.store['polo_active_color_exec'];
        ok(exec && exec.batchId === 'OLD_BATCH', `原执行身份未被覆盖（实际 ${JSON.stringify(exec)}）`);

        // 通信失败（页面未就绪）→ 保留待派发身份，不误报 busy
        const env2 = createEnv({
            physAvailGiB: 10, commitFreeMiB: 8192,
            tabsSendMessageResponse: undefined
        });
        env2.tabs.push({ id: 8888, url: 'https://www.doubao.com/chat/yyy' });
        const r2 = await env2.run(`openDoubaoAndStartTask({ imagePath:'y.jpg', prompt:'p', rowNum: 500, batchId:'B2' })`);
        await tick(1500);
        ok(r2 && r2.busy !== true, `通信失败不误报 busy（实际 ${JSON.stringify(r2)}）`);
        ok(env2.store['polo_active_color_exec'].batchId === 'B2', '通信失败保留待派发身份');

        // 接收成功 → 身份提升为 accepted
        const env3 = createEnv({
            physAvailGiB: 10, commitFreeMiB: 8192,
            tabsSendMessageResponse: { ok: true, accepted: true }
        });
        env3.tabs.push({ id: 9999, url: 'https://www.doubao.com/chat/zzz' });
        const r3 = await env3.run(`openDoubaoAndStartTask({ imagePath:'z.jpg', prompt:'p', rowNum: 600, batchId:'B3' })`);
        await tick(1500);
        ok(r3 && r3.ok === true && r3.accepted === true, `接收成功返回 accepted（实际 ${JSON.stringify(r3)}）`);
        ok(env3.store['polo_active_color_exec'].state === 'accepted', `身份提升为 accepted（实际 ${env3.store['polo_active_color_exec'].state}）`);

        // 豆包确认接收消息也能提升身份（新页路径）
        const env4 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192 });
        await env4.run(`saveActiveColorExec({ batchId:'B4', rowNum: 700, source:'batch', fileKey:'', fileFolder:'默认', tabId:1, state:'pending', startedAt: Date.now() })`);
        await tick(50);
        const a = await env4.sendInternal({ action: 'colorTaskAccepted', rowNum: 700, batchId: 'B4' }, { tab: { id: 1 } });
        await tick(150);
        ok(a && a.ok, 'colorTaskAccepted 被接受');
        ok(env4.store['polo_active_color_exec'].state === 'accepted', '接收确认后身份提升为 accepted');
        const a2 = await env4.sendInternal({ action: 'colorTaskAccepted', rowNum: 999, batchId: 'B4' }, { tab: { id: 1 } });
        ok(a2 && a2.ok === false, '身份不符的接收确认被拒绝');
    }

    // ---------- 完成载荷：results 必须贯穿所有通知通道 ----------
    console.log('\n【39】完成终态载荷：results 必须随通知一并送达（否则成功被判失败）');
    {
        const EXEC = { batchId: 'B', rowNum: 412, source: 'batch', state: 'accepted', fileKey: 'A__', fileFolder: 'A文件', startedAt: Date.now() };
        const env = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, initialStore: { 'polo_active_color_exec': EXEC } });
        await tick(200);
        const RESULTS = { success: false, error: '上传失败', downloads: [] };
        await env.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: RESULTS, batchId: 'B' }, { tab: { id: 1 } });
        await tick(300);

        // 存储事件：同一份载荷
        const ev = env.store['color_task_complete_event'];
        ok(ev && ev.results && ev.results.error === '上传失败', `存储事件携带 results（实际 ${JSON.stringify(ev && ev.results)}）`);
        ok(ev && ev.fileKey === 'A__' && ev.fileFolder === 'A文件', '存储事件携带执行/文件身份');

        // 通知通道：也必须带 results（这是页面判定成败的唯一依据）
        const notified = env.sentMessages.filter(m => m && m.action === 'colorTaskComplete');
        ok(notified.length > 0, `至少发出一次完成通知（${notified.length} 次）`);
        const n0 = notified[notified.length - 1] || {};
        ok(n0.results && n0.results.error === '上传失败', `通知载荷携带 results（实际 ${JSON.stringify(n0.results)}）`);
        ok(n0.fileKey === 'A__' && n0.fileFolder === 'A文件', '通知载荷携带文件身份');
        ok(n0.rowNum === 412 && n0.batchId === 'B', '通知载荷携带行号与批次标识');

        // 成功结果同样贯穿
        const env2 = createEnv({ physAvailGiB: 10, commitFreeMiB: 8192, initialStore: { 'polo_active_color_exec': JSON.parse(JSON.stringify(EXEC)) } });
        await tick(200);
        const OKR = {
            success: true,
            downloads: ['white', 'black', 'gray', 'navy'].map(c => ({ ok: true, filename: `row412_${c}.png` }))
        };
        await env2.sendInternal({ action: 'colorTaskComplete', rowNum: 412, results: OKR, batchId: 'B' }, { tab: { id: 1 } });
        await tick(300);
        const n1 = env2.sentMessages.filter(m => m && m.action === 'colorTaskComplete').pop() || {};
        ok(n1.results && Array.isArray(n1.results.downloads) && n1.results.downloads.length === 4,
            `成功结果四色明细随通知送达（实际 ${n1.results && n1.results.downloads && n1.results.downloads.length} 条）`);
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
