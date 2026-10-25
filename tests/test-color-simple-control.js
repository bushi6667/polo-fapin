// 暂停须停止实际扩展执行；旧执行不能干扰继续后的新执行。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const watchdog = setTimeout(() => { console.error('FAIL 测试等待未结束'); process.exit(1); }, 5000);
const doubao = fs.readFileSync(path.join(root, 'chrome_extension/content/doubao.js'), 'utf8');
function fn(name) {
    const lines = doubao.split('\n');
    const start = lines.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
    const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
    assert(start >= 0 && end > start, name);
    return lines.slice(start, end + 1).join('\n');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function backend() {
    const src = fs.readFileSync(path.join(__dirname, 'test-publish-queue.js'), 'utf8');
    const c = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
        URLSearchParams, AbortController, TextDecoder, process };
    vm.createContext(c); vm.runInContext(src.slice(0, src.indexOf('(async function main()')), c);
    return vm.runInContext('createEnv()', c);
}
(async () => {
    let listener; const modeWaiters = [], uploads = [], completions = [];
    const content = { colorTask: null, isProcessing: false, console, log() {},
        chrome: { runtime: { onMessage: { addListener: f => listener = f }, sendMessage: async msg => {
            if (msg.action === 'colorTaskComplete') completions.push(msg);
            return { ok: true };
        } } },
        startHeartbeatForColorTask() {}, stopHeartbeatForColorTask() {}, sleep: async () => {},
        switchToImageGenMode: () => new Promise(resolve => modeWaiters.push(resolve)),
        uploadImage: async image => uploads.push(image), typePrompt: async () => {}, sendMessage: async () => {},
        downloadImagesIncremental: async () => [{ ok: true, filename: 'x' }], runAiEditTask() {} };
    vm.createContext(content);
    const a = doubao.indexOf('chrome.runtime.onMessage.addListener(');
    const b = doubao.indexOf('\n});', a) + 4;
    vm.runInContext(fn('runColorTask') + '\n' + doubao.slice(a, b), content);
    const old = { executionId: 'OLD', rowNum: 412, imagePath: 'old.jpg', prompt: 'old' };
    const next = { executionId: 'NEW', rowNum: 412, imagePath: 'new.jpg', prompt: 'new' };
    listener({ action: 'startColorTask', task: old }, {}, () => {}); await delay(10);
    assert.equal(content.isProcessing, true);
    listener({ action: 'cancelColorTask', executionId: 'OLD' }, {}, () => {});
    assert.equal(content.isProcessing, false);
    listener({ action: 'startColorTask', task: next }, {}, () => {}); await delay(10);
    listener({ action: 'cancelColorTask', executionId: 'OLD' }, {}, () => {});
    assert.equal(content.isProcessing, true, '旧取消不得停止新执行');
    modeWaiters[0](); await delay(10);
    assert.equal(uploads.length, 0, '旧流程恢复后不能继续上传');
    assert.equal(content.isProcessing, true, '旧流程收尾不能清除新流程运行状态');
    modeWaiters[1](); await delay(10);
    assert.deepEqual(uploads, ['new.jpg']);
    assert.deepEqual(completions.map(c => c.executionId), ['NEW']);
    console.log('PASS 实际豆包执行器取消后可重新执行，旧流程不上传、不完成、不覆盖新状态');

    let wake, downloads = 0;
    const downloading = { rowNum: 412, executionId: 'WAITING' };
    const loop = { colorTask: downloading, isProcessing: true, Date, Set, log() {}, rawUrlMap: new Map(),
        getAllImageUrls: () => [], sleep: () => new Promise(resolve => wake = resolve),
        chrome: { runtime: { sendMessage: async () => { downloads++; return { ok: true }; } } } };
    vm.createContext(loop); vm.runInContext(fn('downloadImagesIncremental'), loop);
    loop.execution = downloading;
    const waiting = vm.runInContext('downloadImagesIncremental(412,600000,4,execution)', loop);
    loop.colorTask = null; loop.isProcessing = false; wake();
    assert.equal((await waiting).length, 0); assert.equal(downloads, 0);
    console.log('PASS 等图片时暂停终止下载循环，不再继续等待或下载');

    const e = backend(); await delay(100);
    e.run("saveActiveColorExec({state:'accepted',executionId:'OLD',batchId:'B',rowNum:412,tabId:7,fileKey:''})");
    await delay(20);
    let sent;
    e.ctx.chrome.tabs.sendMessage = async (id, msg) => { sent = { id, msg }; return { ok: true }; };
    await e.sendExternal({ action: 'pauseColorDispatch' });
    assert.equal(e.store.polo_active_color_exec.state, 'cancelled');
    assert.equal(sent.id, 7); assert.equal(sent.msg.action, 'cancelColorTask');
    assert.equal((await e.sendInternal({ action: 'colorTaskComplete', executionId: 'OLD', batchId: 'B', rowNum: 412 }, { tab: { id: 7 } })).ok, false);
    console.log('PASS 暂停后台使已接收执行失效并通知取消，旧完成被拒绝');

    await e.run("saveActiveColorExec({state:'accepted',executionId:'CLOSED',batchId:'B2',rowNum:415,tabId:8,fileKey:''})");
    e.L.onRemoved.forEach(f => f(8)); await delay(40);
    assert.equal(e.store.polo_active_color_exec.state, 'cancelled');
    const events = await e.sendExternal({ action: 'getColorTaskEvents' });
    assert.equal(events.events.color_task_stopped_event.executionId, 'CLOSED');
    console.log('PASS 真实关页入口清除运行身份，停止事件可被页面轮询补收');
    await e.run('stopPublishTick()');
})().then(() => { clearTimeout(watchdog); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
