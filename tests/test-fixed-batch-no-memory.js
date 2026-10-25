// 当前需求：每批固定 50，手动继续，不使用内存监测或本地服务。
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
    const env = vm.runInContext('createEnv()', context);
    let memoryCalls = 0;
    env.ctx.fetch = () => { memoryCalls++; throw Error('本地服务未启动'); };
    env.ctx.chrome.system = undefined;
    await new Promise(r => setTimeout(r, 100));
    env.store.polo_publish_settings = { batchSize: 3 };
    const settings = await env.sendExternal({ action: 'setPublishSettings', patch: { batchSize: 60 } });
    assert.equal(settings.settings.batchSize, 50);
    const created = await env.sendExternal({ action: 'openBatchPublish', rows: Array.from({ length: 120 }, (_, i) => i + 1) });
    assert.equal(created.ok, true);
    context.env = env;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await vm.runInContext('driveFills(env, 50)', context), 50);
    let state = await env.sendExternal({ action: 'getPublishState' });
    assert.equal(state.state, 'paused');
    assert.equal(state.pauseReason, 'batch');
    assert.equal(state.remaining, 70);
    assert.equal(env.createdUrls.length, 50);
    assert.equal(state.savedCount, 0);
    assert.equal(state.pendingSaveCount, 50);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(env.createdUrls.length, 50, '暂停后不开第 51 页');
    assert.equal(memoryCalls, 0);
    assert.equal(env.tabs.length, 50, '没有自动关闭页面');
    // 原页面保留，仍必须完整推进下一批 50，不能被旧 60 页上限截断。
    assert.equal((await env.sendExternal({ action: 'resumePublishQueue' })).ok, true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await vm.runInContext('driveFills(env, 50)', context), 50);
    state = await env.sendExternal({ action: 'getPublishState' });
    assert.equal(state.state, 'paused');
    assert.equal(state.remaining, 20);
    assert.equal(env.createdUrls.length, 100);
    assert.equal(env.tabs.length, 100, '原页面未自动关闭，第二批仍开满 50');
    assert.equal(state.batchSize, 50);
    assert.equal(memoryCalls, 0);
    assert.equal((await env.sendExternal({ action: 'getMemoryGate' })).disabled, true);
    await env.run('stopPublishTick()');

    const html = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) new vm.Script(match[1]);
    }
    assert.equal(html.includes('id="memPauseInput"'), false);
    assert.equal(html.includes('queryMemoryGate('), false);
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
    console.log('PASS：两批各 50 后暂停、手动继续、未保存仍待保存、无内存/本地服务依赖、换色轮询与脚本语法');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
