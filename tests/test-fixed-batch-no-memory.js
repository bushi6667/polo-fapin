// 当前需求：每批款数由用户设置（1-500，说几就一批发几个），手动继续，不使用内存监测或本地服务。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const harness = fs.readFileSync(path.join(__dirname, 'test-publish-queue.js'), 'utf8');
const context = { require, __dirname, console, setTimeout, clearTimeout, setInterval,
    clearInterval, URLSearchParams, AbortController, TextDecoder, process };
vm.createContext(context);
vm.runInContext(harness.slice(0, harness.indexOf('(async function main()')), context);

(async () => {
    // ---------- 主流程：设置 60 → 每批就是 60 ----------
    const env = vm.runInContext('createEnv()', context);
    let memoryCalls = 0;
    env.ctx.fetch = () => { memoryCalls++; throw Error('本地服务未启动'); };
    env.ctx.chrome.system = undefined;
    await new Promise(r => setTimeout(r, 100));
    env.store.polo_publish_settings = { batchSize: 3 };   // 旧值 3，被下面的设置覆盖
    const settings = await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 60 } });
    assert.equal(settings.ok, true);
    assert.equal(settings.settings.batchSize, 60, '设置 60 必须生效，不能再被强制改回 50');
    assert.equal(env.store.polo_publish_settings.batchSize, 60, '60 已落盘');
    const created = await env.sendExternal({ action: 'openBatchPublish', rows: Array.from({ length: 120 }, (_, i) => i + 1) });
    assert.equal(created.ok, true);
    assert.equal(created.batchSize, 60, '创建任务返回真实批次 60');
    context.env = env;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await vm.runInContext('driveFills(env, 60)', context), 60);
    let state = await env.sendExternal({ action: 'getPublishState' });
    assert.equal(state.state, 'paused');
    assert.equal(state.pauseReason, 'batch');
    assert.equal(state.batchSize, 60, '任务 state 的 batchSize 也是 60');
    assert.equal(state.remaining, 60);
    assert.equal(env.createdUrls.length, 60);
    assert.equal(state.savedCount, 0);
    assert.equal(state.pendingSaveCount, 60);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(env.createdUrls.length, 60, '暂停后不开第 61 页');
    assert.equal(memoryCalls, 0);
    assert.equal(env.tabs.length, 60, '没有自动关闭页面');

    // 暂停中改批次 → 立即同步到任务的"下一批"（运行中不改当前批次）
    const s30 = await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 30 } });
    assert.equal(s30.settings.batchSize, 30);
    assert.equal((await env.run('loadPublishTask()')).batchSize, 30, '暂停中改设置立即同步到任务');

    // 再改回 60：继续后第二批仍开满 60（原页面保留，不被旧页上限截断）
    await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 60 } });
    assert.equal((await env.sendExternal({ action: 'resumePublishQueue' })).ok, true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await vm.runInContext('driveFills(env, 60)', context), 60);
    state = await env.sendExternal({ action: 'getPublishState' });
    assert.equal(state.state, 'done');
    assert.equal(state.remaining, 0);
    assert.equal(env.createdUrls.length, 120);
    assert.equal(env.tabs.length, 120, '原页面未自动关闭，第二批仍开满 60');
    assert.equal(state.batchSize, 60);
    assert.equal(memoryCalls, 0);
    assert.equal((await env.sendExternal({ action: 'getMemoryGate' })).disabled, true);
    await env.run('stopPublishTick()');

    // ---------- 边界：空/非数字回退默认 50；小于 1 夹到 1；大于 500 夹到 500 ----------
    const env2 = vm.runInContext('createEnv()', context);
    env2.ctx.chrome.system = undefined;
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await env2.run('getPublishSettings()')).batchSize, 50, '无任何设置时默认 50');
    env2.store.polo_publish_settings = { batchSize: 'xyz' };
    assert.equal((await env2.run('getPublishSettings()')).batchSize, 50, '存量脏值 → 50');
    // 口径：非数字/空 → 50；< 1 → 1；> 500 → 500
    const cases = [[0, 1, '0'], [-5, 1, '-5'], ['abc', 50, 'abc'], ['', 50, "''"], [null, 50, 'null'],
        [10000, 500, '10000'], [1, 1, '1'], [500, 500, '500'], ['37', 37, "'37'"]];
    for (const [input, expect, label] of cases) {
        const r = await env2.sendExternal({ action: 'setPublishSettings', patch: { batchSize: input } });
        assert.equal(r.settings.batchSize, expect, `设置 ${label} → 期望 ${expect}（实际 ${r.settings.batchSize}）`);
    }
    // 只改别的字段时不得动 batchSize（不再无条件覆盖）
    const keep = await env2.sendExternal({ action: 'setPublishSettings', patch: { rowTimeoutMs: 120000 } });
    assert.equal(keep.settings.batchSize, 37, '不传 batchSize 时保留当前值 37');
    assert.equal((await env2.run('stopPublishTick()')), undefined);

    // ---------- 老任务没有 batchSize → 读取时补成当前设置值 ----------
    const env3 = vm.runInContext('createEnv()', context);
    env3.ctx.chrome.system = undefined;
    await new Promise(r => setTimeout(r, 100));
    await env3.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 25 } });
    env3.store.polo_publish_task = {
        taskId: 'pt_legacy', fileKey: '', products: {}, total: 3, remaining: [1, 2, 3],
        filledCount: 0, filledRows: [], batchFilled: 0, batchFilledDone: 0,
        state: 'paused', pauseReason: 'manual', pauseDetail: '', currentRow: null, currentTabId: null
    };
    const legacy = await env3.run('loadPublishTask()');
    assert.equal(legacy.batchSize, 25, '老任务缺 batchSize → 补成当前设置值 25（不再改成 50）');
    // 老任务的 legacy 暂停原因仍归一为 manual，且文案里的款数跟着实际值走
    env3.store.polo_publish_task.pauseReason = 'memory';
    const legacy2 = await env3.run('loadPublishTask()');
    assert.equal(legacy2.pauseReason, 'manual');
    assert.equal(legacy2.pauseDetail.includes('每批 25 款'), true, '文案用真实批次：' + legacy2.pauseDetail);
    assert.equal(legacy2.resourceBlockDetail, '');
    assert.equal((await env3.run('stopPublishTick()')), undefined);

    // ---------- 每批 1 款：合法极小值，每填 1 款就暂停，计数与文案正常 ----------
    const env4 = vm.runInContext('createEnv()', context);
    env4.ctx.chrome.system = undefined;
    await new Promise(r => setTimeout(r, 100));
    await env4.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 1 } });
    const one = await env4.sendExternal({ action: 'openBatchPublish', rows: [601, 602] });
    assert.equal(one.ok, true);
    assert.equal(one.batchSize, 1, '每批 1 款也照做');
    context.env = env4;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await vm.runInContext('driveFills(env, 1)', context), 1);
    const st1 = await env4.sendExternal({ action: 'getPublishState' });
    assert.equal(st1.state, 'paused');
    assert.equal(st1.pauseReason, 'batch');
    assert.equal(st1.batchSize, 1);
    assert.equal(st1.batchFilled, 1, '本批已填 1/1');
    assert.equal(st1.remaining, 1);
    assert.equal(env4.createdUrls.length, 1, '每批 1 款只开 1 页，第 2 页等继续');
    assert.equal(st1.pauseDetail.includes('1/1'), true, '暂停文案按真实值显示 1/1：' + st1.pauseDetail);
    assert.equal((await env4.run('stopPublishTick()')), undefined);

    // ---------- 界面：输入框存在、可改，且不再写死 50 ----------
    const html = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) new vm.Script(match[1]);
    }
    assert.equal(html.includes('id="memPauseInput"'), false);
    assert.equal(html.includes('queryMemoryGate('), false);
    assert.equal(html.includes('id="pubBatchSize"'), true, '每批款数输入框存在');
    assert.equal(html.includes('每批固定 50 款'), false, '不再写死"每批固定 50 款"');
    assert.equal(html.includes('继续下一批（50 款）'), false, '按钮 title 不再写死 50');
    assert.equal(html.includes('action: \'setPublishSettings\', patch: { batchSize: v }'), true, '输入框改动会写回设置');
    function extract(name) {
        const lines = html.split('\n').map(l => l.replace(/\r$/, ''));
        const start = lines.findIndex(l => l.startsWith('function ' + name + '('));
        const end = lines.findIndex((l, i) => i > start && l === '}');
        assert(start >= 0 && end > start);
        return lines.slice(start, end + 1).join('\n');
    }
    let dispatched = 0, poll, messages = 0, eventQueries = 0;
    const color = { EXTENSION_ID: 'fixture', batchColorState: { running: true, currentIndex: 0, queue: [{ row: 412 }] },
        sendNextBatchColor: () => dispatched++, finishBatchColor: () => {},
        setInterval: fn => { poll = fn; return 1; }, clearInterval() {}, console,
        chrome: { storage: { local: { get: (_, cb) => cb({}) } },
            runtime: { lastError: null, sendMessage: (_, msg, cb) => { if (msg.action === 'getMemoryGate') { messages++; throw Error('不应查询内存'); } if (msg.action === 'getColorTaskEvents') eventQueries++; cb({ ok: true, events: {} }); } } } };
    vm.createContext(color);
    vm.runInContext(extract('processNextBatchColor') + '\n' + extract('startBatchColorPolling'), color);
    color.handleColorTaskAccepted = () => {};
    color.processNextBatchColor();
    assert.equal(dispatched, 1, '换色派发不依赖资源服务');
    color.startBatchColorPolling();
    poll();
    assert.equal(eventQueries, 1, '通过消息轮询持久化完成事件');
    assert.equal(messages, 0, '完成轮询不再查询内存');
    console.log('PASS：批次可设（60 就是 60）、越界夹到 1-500、空/非数字回退 50、每批 1 款可用、老任务补当前设置值、手动继续、未保存仍待保存、无内存/本地服务依赖、换色轮询与脚本语法');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
