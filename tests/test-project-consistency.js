// Project boundaries: production functions + real message paths; no platform save/generation.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, '发品助手.html'), 'utf8');
function fn(name, source = html) {
    const lines = source.split('\n');
    const start = lines.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
    const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
    assert(start >= 0 && end > start, name);
    return lines.slice(start, end + 1).join('\n');
}
function harness(name) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const ctx = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, AbortController, TextDecoder, process };
    vm.createContext(ctx);
    vm.runInContext(source.slice(0, source.indexOf('(async function main()')), ctx);
    return ctx;
}
function ui() {
    const h = harness('test-color-batch-pause.js');
    const e = vm.runInContext('createEnv()', h);
    const elements = new Map();
    e.ctx.document.getElementById = id => {
        if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', disabled: false });
        return elements.get(id);
    };
    for (const [helper, id] of Object.entries({ batchColorProgressEl: 'batchColorProgress', batchColorStatusEl: 'batchColorStatus', batchColorFillEl: 'batchColorFill', batchColorCounterEl: 'batchColorCounter', batchColorCurrentEl: 'batchColorCurrent' })) {
        e.ctx[helper] = () => e.ctx.document.getElementById(id);
    }
    vm.runInContext(['updateBatchColorProgress', 'updateBatchColorFill', 'updateBatchColorStatus', 'setBatchColorToggle', 'restoreBatchColorUI', 'syncColorResumeButton'].map(n => fn(n)).join('\n'), e.ctx);
    return { h, e, elements, el: id => e.ctx.document.getElementById(id) };
}
(async () => {
    const u = ui();
    u.e.run('setColorResumeRows(Array.from({length:600},(_,i)=>i+1))');
    assert.match(u.el('batchColorStatus').textContent, /已暂停.*600/);
    assert(!u.el('batchColorStatus').textContent.includes('准备中'));
    assert.equal(u.el('batchColorToggleBtn').disabled, false);
    const state = vm.runInContext('mkState([412,415], {running:true,inFlightRow:412})', u.h);
    u.e.setState(state);
    u.e.run('syncColorResumeButton()');
    assert.match(u.el('batchColorStatus').textContent, /换色中.*row412/);
    assert.equal(u.el('batchColorCurrent').textContent, '正在处理 row412');
    assert.equal(u.el('batchColorToggleBtn').textContent, '⏸ 暂停');
    state.running = false;
    u.e.run('updateBatchColorProgress(); syncColorResumeButton()');
    assert.equal(u.el('batchColorStatus').textContent, '换色已暂停');
    assert.equal(u.el('batchColorToggleBtn').disabled, false);
    state.inFlightRow = null; state.currentIndex = 1;
    u.e.run('setColorResumeRows([415]); setColorTimeoutRows([412]); syncColorResumeButton()');
    assert.equal(u.el('batchColorFill').style.width,'50%');
    assert.equal(u.el('batchColorCounter').textContent,'1/2');
    assert.equal(u.el('colorCheckExecBtn').style.display, 'none');
    assert.equal(u.el('batchColorToggleBtn').disabled, false);
    state.fileKey = 'OLD__'; state.fileFolder = 'OLD';
    u.e.run('syncColorResumeButton()');
    assert.match(u.el('batchColorStatus').textContent, /原文件「OLD」/);
    u.e.clearTimers();
    const detail = fn('renderDetail');
    assert(!detail.includes('id="batchColorProgress"'), 'task controls must survive product/tab rerenders');
    for (const id of ['batchColorProgress','batchPublishProgress','batchColorFill','batchPublishFill']) {
        assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1, 'one persistent element for '+id);
        assert(html.indexOf('id="'+id+'"') < html.indexOf('id="detailPanel"'), 'progress above details: '+id);
    }
    assert.equal([...html.matchAll(/class="task-progress"/g)].length,2,'same large progress style for both tasks');
    console.log('PASS restored/rebuilt color UI: cached, running, paused, in-flight, timeout and file mismatch');

    const pub = ui();
    const ids = {publishProgressEl:'batchPublishProgress',publishStatusEl:'batchPublishStatus',publishFillEl:'batchPublishFill',publishCounterEl:'batchPublishCounter',publishCurrentEl:'batchPublishCurrent',publishBatchEl:'batchPublishBatch',publishPendingEl:'batchPublishPending',publishPagesEl:'batchPublishPages',publishPauseEl:'batchPublishPause',publishToggleEl:'pubToggleBtn',publishRetryEl:'pubRetryBtn',publishSkipEl:'pubSkipBtn',publishBatchInput:'pubBatchSize'};
    for (const [helper,id] of Object.entries(ids)) pub.e.ctx[helper]=()=>pub.el(id);
    const reasons=html.match(/const PUBLISH_REASON_TEXT = \{[\s\S]*?\n\};/)[0];
    pub.e.ctx.lastPublishState=null;
    vm.runInContext(reasons+'\n'+['showPublishProgress','renderPublishState','togglePublishRun'].map(n=>fn(n)).join('\n'),pub.e.ctx);
    pub.e.ctx.s={state:'running',total:120,filledCount:20,remaining:100,batchSize:50,batchOpened:21,batchFilled:20,currentRow:412,pendingSaveCount:20};
    pub.e.run('renderPublishState(s)');
    assert.equal(pub.el('batchPublishFill').style.width,'17%');
    assert.equal(pub.el('pubToggleBtn').textContent,'⏸ 暂停');
    const actions=[];
    pub.e.ctx.refreshPublishState=()=>{};
    pub.e.ctx.chrome.runtime.sendMessage=(_,msg,cb)=>{actions.push(msg.action);cb({ok:true});};
    pub.e.run('togglePublishRun()');assert.equal(actions.pop(),'pausePublishQueue');
    pub.e.ctx.s={...pub.e.ctx.s,state:'paused',pauseReason:'batch',filledCount:50,remaining:70,currentRow:null,batchFilled:50,batchOpened:50};
    pub.e.run('renderPublishState(s)');
    assert.equal(pub.el('batchPublishFill').style.width,'42%');
    assert.equal(pub.el('pubToggleBtn').disabled,false);
    pub.e.run('togglePublishRun()');assert.equal(actions.pop(),'resumePublishQueue');
    pub.e.run("renderPublishState({state:'idle'})");
    assert.equal(pub.el('batchPublishProgress').style.display,'none');
    pub.e.clearTimers();
    console.log('PASS shared large publish progress: counts, fill, pause/continue actions and idle visibility');

    const colorClick=ui();
    const cs=vm.runInContext('mkState([412,415], {running:true,inFlightRow:null,currentIndex:1,successCount:1})',colorClick.h);
    colorClick.e.setState(cs); colorClick.e.ctx.products=cs.queue;
    vm.runInContext(fn('stopBatchColorChange')+'\n'+fn('toggleBatchColorRun'),colorClick.e.ctx);
    colorClick.e.run('toggleBatchColorRun()');
    assert.equal(cs.running,false); assert.equal(colorClick.el('batchColorToggleBtn').disabled,false);
    assert.equal(colorClick.el('batchColorFill').style.width,'50%');
    colorClick.e.run('toggleBatchColorRun()');assert.equal(colorClick.e.dispatched,1);
    assert.equal(cs.currentIndex,1,'continue resumes current row and preserves overall progress');
    colorClick.e.clearTimers();
    console.log('PASS color progress button pauses the real controller and resumes remaining rows');

    const requests = [], images = [], shown = [];
    const imageCtx = { loadedFileName: 'A', currentProduct: { row: 412 }, extensionInstalled: true,
        getColorImagePath: () => 'A/image.png', Image: function() { images.push(this); },
        setColorImage: (...args) => shown.push(args), EXTENSION_ID: 'x',
        chrome: { runtime: { sendMessage: (_, msg, cb) => requests.push({ msg, cb }) } } };
    vm.createContext(imageCtx); vm.runInContext(fn('currentFileKey') + '\n' + fn('loadColorImagesFromExtension'), imageCtx);
    vm.runInContext('loadColorImagesFromExtension(412)', imageCtx);
    images[0].onerror();
    assert.equal(requests[0].msg.fileKey, 'A__');
    imageCtx.loadedFileName = 'B'; imageCtx.currentProduct = { row: 412 };
    images[1].onload(); requests[0].cb({ ok: true, dataUrl: 'A/old.png' });
    assert.equal(shown.length, 0, 'late image from A must not enter B at same row');
    console.log('PASS async image loading rejects old file/product callbacks');

    const b = harness('test-publish-queue.js');
    const backend = vm.runInContext('createEnv()', b);
    await new Promise(r => setTimeout(r, 100));
    const old = {taskId:'legacy',state:'paused',remaining:[412],pauseReason:'monitorFail',pauseDetail:'Failed to fetch',pageLimit:60};
    backend.ctx.oldTask = old;
    await backend.run('savePublishTask(oldTask)');
    const migrated = await backend.run('loadPublishTask()');
    assert.equal(migrated.pauseReason,'manual'); assert.equal(migrated.pageLimit,undefined);
    assert.equal(migrated.state,'paused','migration cannot start a task automatically');
    await backend.run("saveActiveColorExec({rowNum:412,batchId:'B',executionId:'E',fileKey:'',fileFolder:'A',state:'finished',tabId:7,dispatchAllowed:true})");
    const late = await backend.sendInternal({action:'colorTaskAccepted',rowNum:412,batchId:'B',executionId:'E'}, {tab:{id:7}});
    assert.equal(late.ok, false);
    assert.equal(backend.store.polo_active_color_exec.state, 'finished');
    backend.ctx.getColorImageFromIDB = async () => { await backend.run("CURRENT_FILENAME='B'"); return null; };
    backend.ctx.fetch = async url => ({ok:false,status:url.includes('a.png') ? 418 : 500});
    await backend.run("CURRENT_FILENAME='A'");
    backend.store[await backend.run('colorKey(412)')] = { white: { url: 'https://example.com/a.png' } };
    assert.equal((await backend.run("fetchColorImageAsBase64(412,'white','A__')")).error, 'HTTP 418');
    assert.equal((await backend.run("fetchColorImageAsBase64(412,'white','A__')")).error, '颜色图所属文件已切换');
    backend.store.color_images_row_999 = {white:'legacy',black:'legacy',gray:'legacy',navy:'legacy'};
    assert.equal((await backend.sendExternal({action:'getColorImagesInfo',rowNum:999})).images.length,0);
    assert(backend.store.color_images_row_999,'unbound historical images must remain available without being assigned to a named file');
    console.log('PASS completed execution cannot resurrect; image cache reads retain request file');

    await backend.run("saveActiveColorExec({rowNum:412,batchId:'B',executionId:'STOP',fileKey:'B__',fileFolder:'B',state:'pending',dispatchAllowed:true}); stopPendingColorDispatch()");
    assert.equal(await backend.run("bindPendingColorTab({rowNum:412,batchId:'B',executionId:'STOP'},7)"), false);
    assert.equal(backend.store.polo_active_color_exec.state, 'cancelled');
    await backend.run('saveActiveColorExec(null)');
    const edit = await backend.run("openDoubaoForAiEdit({rowNum:412,imagePath:'B/main.jpg',prompt:'fixture'})");
    assert.equal(edit.pending, true);
    const edits = [];
    backend.ctx.chrome.tabs.sendMessage = async (_, msg) => { edits.push(msg); return {ok:true}; };
    assert.equal((await backend.run('dispatchPendingAiEdit(' + edit.tabId + ')')).ok,true);
    assert.equal(edits[0].action,'startAiEditTask'); assert.equal(edits[0].task.rowNum,412);
    assert.equal(backend.store.polo_pending_ai_edit,undefined);
    console.log('PASS stopped pending execution stays cancelled; new-page AI edit dispatch reaches content script');

    const doubao = fs.readFileSync(path.join(root,'chrome_extension/content/doubao.js'),'utf8');
    const listenerStart = doubao.indexOf('chrome.runtime.onMessage.addListener(');
    const listenerEnd = doubao.indexOf('\n});',listenerStart) + 4;
    let accept, listener, reply; let modeCalls = 0;
    const content = { isProcessing:false, colorTask:null, log(){},
        chrome:{runtime:{onMessage:{addListener: fn=>listener=fn},sendMessage: msg=>msg.action==='colorTaskAccepted' ? new Promise(r=>accept=r) : Promise.resolve({ok:true})}},
        startHeartbeatForColorTask(){},stopHeartbeatForColorTask(){},
        switchToImageGenMode: async()=>{modeCalls++;throw new Error('fixture stops before generation');}, runAiEditTask(){},sleep:async()=>{} };
    vm.createContext(content); vm.runInContext(fn('runColorTask',doubao) + '\n' + doubao.slice(listenerStart,listenerEnd),content);
    listener({action:'startColorTask',task:{rowNum:412,batchId:'B',executionId:'E'}},{},r=>reply=r);
    assert.equal(reply,undefined,'must wait for authoritative acceptance');
    accept({ok:false}); await new Promise(r=>setTimeout(r,10));
    assert.equal(reply.ok,false); assert.equal(modeCalls,0);
    reply=undefined;
    listener({action:'startColorTask',task:{rowNum:412,batchId:'B',executionId:'E'}},{},r=>reply=r);
    assert.equal(reply,undefined); accept({ok:true}); await new Promise(r=>setTimeout(r,10));
    assert.equal(reply.accepted,true); assert.equal(modeCalls,1);
    console.log('PASS real content message entrypoint waits for backend acceptance; refusal never starts generation');

    const page2 = fs.readFileSync(path.join(root,'chrome_extension/content/page2.js'),'utf8');
    const p = { URL, URLSearchParams, window:{location:{search:'?row=412&task=T',href:'https://post.alibaba.com/product/easyListing'}, open: url => url,
        addEventListener() {}}, sessionStorage:{setItem() {}}, document:{querySelectorAll:()=>[]},
        Location:{prototype:{}}, History:{prototype:{pushState(){},replaceState(){}}}, location:{}, setInterval(){} };
    vm.createContext(p); vm.runInContext(fn('setupNextStepRowPass',page2),p);
    vm.runInContext('setupNextStepRowPass(412)',p);
    const target = new URL(vm.runInContext("window.open('https://post.alibaba.com/product/publish?row=999#form')",p));
    assert.equal(target.searchParams.get('row'),'412'); assert.equal(target.searchParams.get('task'),'T'); assert.equal(target.hash,'#form');
    // 图片目录已改为「后台按任务绑定后注入 data._publishImageDir」，页面不再自己拼目录：
    // 断言改为校验页面通过 uploadPublicationImages + _publishFileKey 交给后台决定目录。
    // 契约：图片目录由后台按任务绑定注入（background 提供 _publishImageDir），页面经 uploadPublicationImages 交后台决定目录。
    const bgSrc = fs.readFileSync(path.join(root,'chrome_extension/background.js'),'utf8');
    assert(bgSrc.includes('_publishImageDir: t.imageDir'),'后台把任务图片目录注入整段数据');
    assert(page2.includes('uploadPublicationImages'),'page2 通过后台上传入口处理图片');
    assert(page2.includes('_publishFileKey'),'page2 带上任务绑定的文件标识');
    assert(!fn('handleFile').includes("action: 'clearAllOnNewFile'"));
    console.log('PASS page 2 preserves task+row on new-window navigation and bound image directory; file switch never clears results');

    const manifest = JSON.parse(fs.readFileSync(path.join(root,'chrome_extension/manifest.json'),'utf8'));
    const referenced = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap(c=>c.js)];
    for(const file of referenced) assert(fs.existsSync(path.join(root,'chrome_extension',file)),file);
    const declarations = [...html.matchAll(/^(?:async )?function (\w+)\(/gm)].map(m=>m[1]);
    assert.equal(new Set(declarations).size,declarations.length,'duplicate top-level functions');
    assert(!manifest.permissions.includes('system.memory'));
    console.log('PASS manifest entrypoints and single top-level function definitions');
    console.log('PASS project consistency');
    process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
