// Production functions and message entry points; no live publishing or file writes.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const wait = ms => new Promise(r => setTimeout(r, ms));
function harness(name) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const c = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
        URLSearchParams, AbortController, TextDecoder, process };
    vm.createContext(c);
    vm.runInContext(source.slice(0, source.indexOf('(async function main()')), c);
    return c;
}
const backend = harness('test-publish-queue.js');
const colorHarness = harness('test-color-batch-pause.js');
const html = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');
function fn(name) {
    const lines = html.split('\n').map(l => l.replace(/\r$/, '')), start = lines.findIndex(l => l.startsWith('function ' + name + '('));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    assert(start >= 0 && end > start, name);
    return lines.slice(start, end + 1).join('\n');
}
async function env() {
    const e = vm.runInContext('createEnv()', backend);
    await wait(100);
    return e;
}
const results = row => ({ downloads: ['white', 'black', 'gray', 'navy'].map(c => ({ ok: true, filename: `row${row}_${c}.png` })) });

(async () => {
    const e = await env();
    const old = await e.sendExternal({ action: 'openBatchPublish', rows: [412, 415],
        products: [{ row: 412, title_en: 'OLD' }, { row: 415, title_en: 'OLD_415' }], fileKey: '' });
    assert.equal(old.ok, true);
    await e.sendExternal({ action: 'pausePublishQueue' });
    assert.equal((await e.sendExternal({ action: 'saveBatchProducts', products: [{ row: 412, title_en: 'NEW' }] })).ok, false);
    assert.equal((await e.sendExternal({ action: 'openBatchPublish', rows: [412], products: [{ row: 412, title_en: 'NEW' }] })).ok, false);
    assert.equal((await e.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: old.taskId })).data.title_en, 'OLD');
    e.store.product__row412 = { row: 412, title_en: 'ALTERED_SHARED_CACHE' };
    assert.equal((await e.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: old.taskId })).data.title_en, 'OLD', 'task snapshot remains immutable');
    await e.run('stopPublishTick()');
    console.log('PASS atomic task creation and immutable product data');

    const images = await env();
    images.run("CURRENT_FILENAME='A.xlsx'");
    const imageTask = await images.sendExternal({ action: 'openBatchPublish', rows: [412, 415],
        products: [{ row: 412 }, { row: 415 }], fileKey: 'A_xlsx__', imageDir: 'C:/A/extracted_images', colorImgDir: 'C:/colors' });
    assert.equal(imageTask.ok, true);
    await images.sendExternal({ action: 'setCurrentFilename', filename: 'B.xlsx' });
    const imageProduct = await images.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: imageTask.taskId });
    assert.equal(imageProduct.data._publishImageDir, 'C:/A/extracted_images');
    const imagePath = await images.sendInternal({ action: 'getColorImagePath', taskId: imageTask.taskId, rowNum: 412, color: 'navy' });
    assert.equal(imagePath.path, 'C:/colors/Polo发品_颜色图/A.xlsx/row412/row412_navy.png');
    assert.equal((await images.sendInternal({ action: 'getColorImagePath', taskId: imageTask.taskId, rowNum: 999, color: 'navy' })).ok, false);
    await images.run('stopPublishTick()');
    console.log('PASS publish images retain task-bound folders after file switch');

    const queuedColor = await env();
    queuedColor.run('colorStartLock = new Promise(resolve => globalThis.releaseColorStart = resolve)');
    const queuedStart = queuedColor.run("openDoubaoAndStartTask({rowNum:412,batchId:'B',fileKey:'',imagePath:'x.jpg'})");
    await queuedColor.sendExternal({ action: 'pauseColorDispatch' });
    queuedColor.ctx.releaseColorStart();
    assert.equal((await queuedStart).ok, false);
    assert.equal(queuedColor.createdUrls.length, 0);
    assert.equal(queuedColor.store.polo_pending_color_task, undefined);
    console.log('PASS queued color start cannot clear a newer stop');

    const pending = await env();
    const started = await pending.run("openDoubaoAndStartTask({rowNum:412,batchId:'B',fileKey:'',fileFolder:'A',executionId:'E',imagePath:'x.jpg'})");
    assert.equal(started.pending, true);
    assert.equal(await pending.run("colorDispatchAllowed({rowNum:412,batchId:'B',executionId:'E'}," + started.tabId + ')'), true);
    await pending.sendExternal({ action: 'pauseColorDispatch' });
    assert.equal(await pending.run("colorDispatchAllowed({rowNum:412,batchId:'B',executionId:'E'}," + started.tabId + ')'), false);
    assert.equal((await pending.sendInternal({ action: 'colorTaskAccepted', rowNum: 412, batchId: 'B', executionId: 'E' }, { tab: { id: started.tabId } })).ok, false);
    assert.equal(pending.store.polo_pending_color_task, undefined);
    console.log('PASS stopped pending dispatch cannot accept or replay');

    const ack = await env();
    await ack.run("saveActiveColorExec({rowNum:412,batchId:'B',fileKey:'',fileFolder:'A',executionId:'E',state:'pending',tabId:7,dispatchAllowed:true})");
    const message = { action: 'colorTaskAccepted', rowNum: 412, batchId: 'B', executionId: 'E' };
    assert.equal((await ack.sendInternal(message, { tab: { id: 8 } })).ok, false);
    assert.equal((await ack.sendInternal(message, { tab: { id: 7 } })).ok, true);
    assert.equal(ack.store.polo_active_color_exec.tabId, 7);
    assert.equal(ack.store.color_task_accepted_event.executionId, 'E');
    ack.ctx.notifications = [];
    ack.run('assistantPort = {postMessage: msg => notifications.push(msg)}');
    const complete = { action: 'colorTaskComplete', rowNum: 412, batchId: 'B', executionId: 'E', results: results(412) };
    assert.equal((await ack.sendInternal({ ...complete, executionId: 'OLD' }, { tab: { id: 7 } })).ok, false);
    assert.equal((await ack.sendInternal(complete, { tab: { id: 7 } })).ok, true);
    await wait(30);
    assert.equal(ack.store.color_task_complete_event.executionId, 'E');
    assert.equal(ack.ctx.notifications.find(n => n.action === 'colorTaskComplete').results.downloads.length, 4);
    assert.equal(ack.ctx.notifications.find(n => n.action === 'colorTaskComplete').executionId, 'E');
    assert.equal((await ack.sendInternal(complete, { tab: { id: 7 } })).ok, false);
    console.log('PASS sender binding, durable acceptance, execution token and complete payload');

    const webpage = vm.runInContext('createEnv()', colorHarness);
    const waiting = vm.runInContext('mkState([412,415], {running:false,inFlightRow:412})', colorHarness);
    waiting.executionId = 'E'; waiting.batchId = 'B'; waiting.fileKey = '';
    webpage.setState(waiting);
    webpage.ctx.chrome.storage = undefined;
    webpage.ctx.chrome.runtime.sendMessage = (_, message, cb) => ack.sendExternal(message).then(cb);
    webpage.run('startBatchColorPolling()');
    await wait(240);
    assert.equal(waiting.successCount, 1, 'external webpage queries events through background messages');
    assert.equal(webpage.dispatched, 0, 'paused polling does not dispatch');
    webpage.clearTimers();
    console.log('PASS completion polling without webpage chrome.storage access');

    const dl = await env();
    const idbWrites = [], downloadPaths = [], listeners = new Set();
    let releaseFetch;
    dl.ctx.fetch = () => new Promise(resolve => releaseFetch = resolve);
    dl.ctx.FileReader = class {
        readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onloadend(); }
    };
    dl.ctx.saveColorImageToIDB = async (key, data) => { idbWrites.push(key); return true; };
    dl.ctx.setTimeout = (fn, ms) => ms > 5000 ? 0 : setTimeout(fn, ms);
    dl.ctx.chrome.downloads.onChanged = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
    dl.ctx.chrome.downloads.download = (options, cb) => {
        downloadPaths.push(options.filename); cb(77);
        setTimeout(() => { for (const listener of [...listeners]) listener({ id: 77, state: { current: 'complete' } }); }, 10);
    };
    dl.ctx.chrome.downloads.search = (_, cb) => cb([{ filename: downloadPaths.at(-1) }]);
    const downloading = dl.run("downloadDoubaoImage('https://fixture/image','row412_white.png',412,Object.freeze({fileKey:'A_xlsx__',fileFolder:'A.xlsx'}))");
    await wait(10);
    dl.run("CURRENT_FILENAME='B.xlsx'; activeColorExec={fileKey:'B_xlsx__',fileFolder:'B.xlsx'}");
    const response = { ok: true, blob: async () => ({ type: 'image/png' }) };
    releaseFetch(response);
    assert.equal((await downloading).ok, true);
    assert.equal(downloadPaths[0], 'Polo发品_颜色图/A.xlsx/row412/row412_white.png');
    assert(idbWrites.includes('A_xlsx__row412__white'));
    assert(dl.store.A_xlsx__color__412.white);
    assert.equal(dl.store.B_xlsx__color__412, undefined);
    dl.ctx.fetch = async () => response;
    assert.equal((await dl.run("downloadViaFetch('https://fixture/image','row412_black.png',412,'Polo发品_颜色图/A.xlsx/row412/row412_black.png',{fileKey:'A_xlsx__',fileFolder:'A.xlsx'})")).ok, true);
    assert(idbWrites.includes('A_xlsx__row412__black'));
    assert(dl.store.A_xlsx__color__412.black);
    console.log('PASS main and fallback downloads keep their original file after async switch');

    const notificationFallback = await env();
    const notifications = [];
    notificationFallback.run('assistantPort=null; assistantTabId=null');
    notificationFallback.ctx.chrome.runtime.sendMessage = (_, __, cb) => cb({ ok: false });
    notificationFallback.ctx.chrome.tabs.query = async () => [{ id: 900 }];
    notificationFallback.ctx.chrome.tabs.sendMessage = async (_, msg) => { notifications.push(msg); return { ok: true }; };
    notificationFallback.ctx.payload = { results: results(412), fileKey: 'A_xlsx__', executionId: 'E', timestamp: Date.now() };
    await notificationFallback.run("notifyColorTaskComplete(412,'B',payload)");
    assert.equal(notifications[0].executionId, 'E');
    assert.equal(notifications[0].results.downloads.length, 4);
    assert.equal(notifications[0].fileKey, 'A_xlsx__');
    console.log('PASS last-resort notification preserves results and execution identity');

    const ce = vm.runInContext('createEnv()', colorHarness);
    ce.ctx.BATCH_COLOR_COMPLETE_TIMEOUT = 10000;
    ce.ctx.COLOR_PROMPT = 'fixture';
    ce.ctx.getMainImagePath = row => 'A/row' + row + '.jpg';
    vm.runInContext(fn('sendNextBatchColor') + '\n' + fn('handleColorTaskComplete'), ce.ctx);
    const state = vm.runInContext('mkState([412,415], {running:true,inFlightRow:null})', colorHarness);
    state.fileKey = 'A文件_xlsx__'; state.fileFolder = 'A文件';
    ce.setState(state);
    ce.ctx.chrome.runtime.sendMessage = (_, msg, cb) => cb({ ok: true, pending: true });
    ce.run('sendNextBatchColor()');
    assert.equal(state.inFlightRow, 412);
    assert.equal(state.pendingAckRow, 412);
    ce.ctx.event = { rowNum: 412, batchId: state.batchId, executionId: state.executionId, results: results(412) };
    ce.run('handleColorTaskComplete({...event, executionId:"OLD"})');
    assert.equal(state.successCount, 0);
    state.running = false;
    ce.run('handleColorTaskComplete(event)');
    assert.equal(state.successCount, 1);
    assert.equal(state.pendingAckRow, null);
    assert.equal(ce.dispatched, 0);
    assert.equal(ce.run('judgeColorTaskResult(event.results,999).ok'), false);
    ce.run('finishBatchColor(false,"manual")');
    assert.equal(JSON.parse(ce.store.get('polo_color_batch_state::A文件_xlsx__')).running, false);
    ce.ctx.loadedFileName = 'B文件.xlsx';
    ce.run('resumeColorBatch()');
    assert.equal(ce.beginCalls, 0, 'old file rows cannot use new file products');
    ce.clearTimers();
    console.log('PASS pending completion, pause accounting, row ownership, persistence, file switch');

    let selected = false, synced = 0;
    const cached = { localStorage: { getItem: k => ({ polo_products: '[{"row":412}]', polo_loaded_filename: 'A.xlsx', polo_selected_idx: '0' }[k] ?? null) },
        products: [], loadedFileName: '', currentColMap: {}, currentActiveTab: '',
        setTimeout() {}, setInterval: () => 1, clearInterval() {}, restoreColorBatchState() {}, renderProductList() {},
        document: { getElementById: () => ({ style: {} }) },
        chrome: { runtime: { sendMessage: () => synced++ } }, EXTENSION_ID: 'x', selectProduct: () => selected = true, console };
    vm.createContext(cached);
    vm.runInContext('let uploadPollTimer=null;\n' + fn('loadFromLocalStorage') + '\n' + fn('startUploadPolling') + '\nvar restored=loadFromLocalStorage();', cached);
    assert.equal(cached.restored, true); assert.equal(selected, true); assert.equal(synced, 1);
    assert(html.indexOf('let uploadPollTimer = null;') < html.indexOf('\nloadFromLocalStorage();'));
    console.log('PASS cached startup initializes before polling and restores selection');

    let handler;
    const serverSource = fs.readFileSync(path.join(__dirname, '..', '_server.js'), 'utf8');
    const serverContext = { require: name => name === 'http' ? { createServer: fn => { handler = fn; return {}; } } : require(name),
        __dirname: path.resolve(__dirname, '..'), module: { exports: {} }, Buffer, console };
    vm.createContext(serverContext); vm.runInContext(serverSource, serverContext);
    for (const meta of [null, { versions: {} }, { versions: [null] }, { versions: [{ format: 'png', start: -1, size: 2 }] }]) {
        const hooks = {}; let status;
        handler({ method: 'POST', url: '/photopea-save', headers: {}, on: (key, fn) => hooks[key] = fn }, { writeHead: code => status = code, end() {} });
        hooks.data(Buffer.from(JSON.stringify(meta))); hooks.end(); assert.equal(status, 400);
    }
    console.log('PASS malformed metadata rejects without killing the server');
    console.log('PASS flow regressions');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
