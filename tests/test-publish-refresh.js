// 真实页2/页3初始化函数 + 后台消息链；保存后的刷新不得重复填写。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const src2 = fs.readFileSync(path.join(root, 'chrome_extension/content/page2.js'), 'utf8');
const src3 = fs.readFileSync(path.join(root, 'chrome_extension/content/page3.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('FAIL 刷新测试未结束'); process.exit(1); }, 12000);
function fn(name, source = src3) {
    const lines = source.split('\n');
    const start = lines.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
    const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
    assert(start >= 0 && end > start, name);
    return lines.slice(start, end + 1).join('\n');
}
function backend() {
    const source = fs.readFileSync(path.join(__dirname, 'test-publish-queue.js'), 'utf8');
    const c = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
        URLSearchParams, AbortController, TextDecoder, process };
    vm.createContext(c); vm.runInContext(source.slice(0, source.indexOf('(async function main()')), c);
    return vm.runInContext('createEnv()', c);
}
function page(e, task, row, tab, { store = new Map(), dropCompletion = false, stage = 3 } = {}) {
    const writes = [], clicks = [], messages = [], logs = [], listeners = {};
    const saveBtn = { innerText: '保存', offsetHeight: 10, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }) };
    const c = { URLSearchParams, window: { location: { search: '?row=' + row + '&task=' + task } },
        sessionStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) },
        currentProduct: null, document: { querySelectorAll: () => [saveBtn], addEventListener: (name, fn) => { listeners[name] = fn; } },
        updateProductInfo() {}, log: msg => logs.push(msg), ensureTabActive: async () => {},
        startHeartbeat: () => () => {}, setTimeout: callback => setTimeout(callback, 0),
        realClick: async el => clicks.push(el), sleep3: async () => {},
        sendMessageRetry: async msg => {
            messages.push(msg);
            if (dropCompletion && msg.action === 'publishFilled') return { ok: false };
            const response = await e.sendInternal(msg, { tab: { id: tab, url: 'https://post.alibaba.com/product/publish?row=' + row + '&task=' + task }, frameId: 0 });
            if (msg.action === 'savePublishProduct' && response?.ok) clicks.push(saveBtn);
            return response;
        }, autoFillPage2: async () => writes.push('page2') };
    const names = ['fillImagesPage3', 'fillDetailImagesPage3', 'fillTitlePage3', 'fillGroupPage3', 'fillAttributesPage3', 'fillColorsPage3', 'fillSizesPage3',
        'fillSizeTemplate', 'fillPriceUnitPage3', 'fillLadderPricePage3', 'fillBatchQtyPage3', 'fillLogisticsTemplate',
        'fillLogisticsPage3', 'fillBoxRule', 'fillDetailTemplate', 'fillCompanyIntroTemplate'];
    for (const name of names) c[name] = async () => { writes.push(name); return name==='fillDetailTemplate'?['✅ 商品详情模板: 通用']:[]; };
    vm.createContext(c);
    const source = stage === 2 ? [fn('loadBatchProduct', src2)] :
        ['getRowFromUrl', 'getTaskFromUrl', 'observePage3SaveClick', 'fillAllPage3', 'loadBatchProduct', 'saveDraft'].map(n => fn(n));
    vm.runInContext(source.join('\n'), c);
    return { c, store, writes, clicks, messages, logs, listeners, saveBtn, run: code => vm.runInContext(code, c) };
}
(async () => {
    const e = backend(); await delay(100);
    const opened = await e.sendExternal({ action: 'openBatchPublish', rows: [412, 415], products: [{ row: 412 }, { row: 415 }] });
    assert.equal(opened.ok, true);
    const firstTab = e.store.polo_publish_task.currentTabId;
    const p = page(e, opened.taskId, 412, firstTab);
    await p.run('loadBatchProduct(412)');
    assert.equal(p.writes.length, 16);
    assert.equal(e.store.polo_publish_task.filledCount, 1);
    // 2026-10-27 起填完即自动保存，此处由 0 改为 1
    assert.equal((await e.sendExternal({ action: 'getPublishState' })).savedCount, 1, '自动填完即自动保存');
    p.store.set('polo_page3_prefilled::' + opened.taskId + '::412', '1');
    const unsavedRefresh = page(e, opened.taskId, 412, firstTab, { store: p.store });
    await unsavedRefresh.run('loadBatchProduct(412)');
    assert.equal(unsavedRefresh.writes.length, 0, '已自动保存页刷新不重复填入');
    assert.equal(e.store.polo_publish_task.filledCount, 1, '重新填入不能重复推进队列');
    console.log('PASS 已自动保存页刷新不重填，队列不重复计数');
    // 2026-10-27 起填完即自动保存：上面 loadBatchProduct 已点过 1 次保存，这里再显式保存 1 次 → 累计 2 次
    await p.run('saveDraft(currentProduct)'); // 用户定义：菜单点击保存即记账；不伪造平台成功响应。
    assert.equal(p.clicks.length, 2);
    const refreshed = page(e, opened.taskId, 412, firstTab, { store: p.store });
    await refreshed.run('loadBatchProduct(412)');
    assert.equal(refreshed.writes.length, 0);
    assert.equal(e.store.polo_publish_task.filledCount, 1);
    const noCache = page(e, opened.taskId, 412, firstTab);
    await noCache.run('loadBatchProduct(412)');
    assert.equal(noCache.writes.length, 0, '保存记录阻挡重填，不依赖session预填记录');
    const backToPage2 = page(e, opened.taskId, 412, firstTab, { stage: 2 });
    await backToPage2.run('loadBatchProduct(412)');
    assert.equal(backToPage2.writes.length, 0);
    const status = await e.sendExternal({ action: 'getPublishState' });
    assert.equal(status.savedCount, 1); assert.equal(status.pendingSaveCount, 0);
    assert.equal(e.store.polo_publish_verified_saved[''][412].source, 'page3_save_click');
    console.log('PASS 填写→菜单保存记账→刷新/返回页2不重填，旧页无本地标记也受保护');

    const secondTab = e.store.polo_publish_task.currentTabId;
    const wrongTab = page(e, opened.taskId, 415, firstTab);
    await wrongTab.run('loadBatchProduct(415)'); assert.equal(wrongTab.writes.length, 0);
    const second = page(e, opened.taskId, 415, secondTab, { dropCompletion: true });
    await second.run('loadBatchProduct(415)'); assert.equal(second.writes.length, 16);
    assert.equal(e.store.polo_publish_task.currentRow, 415);
    const refreshBeforeAck = page(e, opened.taskId, 415, secondTab, { store: second.store });
    await refreshBeforeAck.run('loadBatchProduct(415)');
    assert.equal(refreshBeforeAck.writes.length, 0, '完成通知丢失也只补通知，不重复填写');
    assert.equal(e.store.polo_publish_task.filledCount, 2);
    assert.equal(e.store.polo_publish_task.state, 'done');
    const finishedUnsaved = page(e, opened.taskId, 415, secondTab);
    await finishedUnsaved.run('loadBatchProduct(415)');
    assert.equal(finishedUnsaved.writes.length, 0, '队列结束后已保存旧页也不重填');
    assert.equal(e.store.polo_publish_task.filledCount, 2);
    const strippedUrl = await e.sendInternal({ action: 'getProductByRow', rowNum: 415, taskId: opened.taskId }, { tab: { id: secondTab, url: 'https://post.alibaba.com/product/publish.htm' }, frameId: 0 });
    assert.equal(strippedUrl.autoFillAllowed, false, '平台去掉查询参数后，已保存页仍不自动重填');
    console.log('PASS 新页填一次、通知丢失只补通知、队列结束已保存页不重填');

    await refreshed.run('fillAllPage3(currentProduct)');
    assert.equal(refreshed.writes.length, 16, '人工明确重填仍可操作');
    // 2026-10-27 起填完即自动保存：row415 在旧任务里已被自动保存（完成通知丢失不影响保存）。
    // 新任务遇到「该行已保存」时：页3 不重填，但**上报 skipped 让队列推进**，
    // 否则队列会停在该行直到 10 分钟超时（同文件重发同一行 100% 命中）。
    const restarted = await e.sendExternal({ action: 'openBatchPublish', rows: [415], products: [{ row: 415 }] });
    const next = page(e, restarted.taskId, 415, e.store.polo_publish_task.currentTabId, { store: second.store });
    await next.run('loadBatchProduct(415)');
    assert.equal(next.writes.length, 0, '已自动保存的行新任务不重填');
    const restartedTask = await e.run('loadPublishTask()');
    assert.equal(restartedTask.filledCount, 1, '已保存行不入账才是错的：上报 skipped 后应记为已完成');
    assert.equal(restartedTask.remaining.length, 0, '队列应推进，不能停在已保存行');
    assert.equal(restartedTask.currentRow, null, '推进后当前行清空');
    console.log('PASS 人工明确重填可操作；新任务遇已自动保存行不重填，队列正常推进');
    await p.run('saveDraft(currentProduct)');   // 旧任务页重复保存 412（已保存）→ 不新增记录
    assert.equal(Object.keys(e.store.polo_publish_verified_saved['']).length, 2, '重复保存不增加已保存款数（412/415 各一条）');
    assert.deepEqual(Object.keys(e.store.polo_publish_verified_saved['']).sort(), ['412', '415']);
    assert.equal((await e.sendExternal({ action: 'getPublishState' })).savedCount, 1, '旧任务的 412 不计入新任务（新任务内 415 已保存）');
    const missing = page(e, restarted.taskId, 415, e.store.polo_publish_task.currentTabId);
    missing.c.document.querySelectorAll = () => [];
    await missing.run('saveDraft({row:417,_publishTaskId:"' + restarted.taskId + '",_publishFileKey:""})');
    assert.equal(e.store.polo_publish_verified_saved[''][417], undefined, '找不到按钮不记保存');
    const denied = await e.sendInternal({ action: 'savePublishProduct', row: 415, x: 60, y: 30, fileKey: '' }, { tab: { id: firstTab, url: 'https://example.com/' }, frameId: 0 });
    assert.equal(denied.ok, false);
    await e.sendExternal({ action: 'setCurrentFilename', filename: '新文件.xlsx' });
    await next.run('saveDraft(currentProduct)');
    assert.equal(e.store.polo_publish_verified_saved[''][415].source, 'page3_save_click', '切文件后旧页仍保存到原文件');
    const originalRows = await e.sendExternal({ action: 'getUploadedRows', fileKey: '' });
    assert(originalRows.rows[415], '助手显式查询原文件，不受后台当前文件影响');
    console.log('PASS 重复点击不重复计数、找不到按钮不记保存、其他页面拒绝、旧页保存绑定原文件');
    await e.run('realClickCDP = async () => ({ok:false}); chrome.scripting.executeScript = async () => [{result:false}]');
    const click = { action: 'savePublishProduct', row: 490, x: 60, y: 30, fileKey: '' };
    const sender = { tab: { id: firstTab, url: 'https://post.alibaba.com/product/publish' }, frameId: 0 };
    assert.equal((await e.sendInternal(click, sender)).ok, false);
    assert.equal(e.store.polo_publish_verified_saved[''][490], undefined, '两种点击方式都失败，不标记保存');
    await e.run('chrome.scripting.executeScript = async () => [{result:true}]');
    assert.equal((await e.sendInternal(click, sender)).ok, true);
    assert.equal(e.store.polo_publish_verified_saved[''][490].source, 'page3_save_click');
    console.log('PASS 点击失败不记保存；原生点击兜底成功才记账');
    const direct = page(e, '', 421, firstTab);
    direct.c.currentProduct = { row: 421, _publishFileKey: '' };
    direct.run('observePage3SaveClick()');
    direct.listeners.click({ isTrusted: false, target: { closest: () => direct.saveBtn } });
    assert.equal(direct.messages.length, 0, '脚本自行触发不记用户保存');
    direct.listeners.click({ isTrusted: true, target: { closest: () => direct.saveBtn } });
    await delay(100);
    assert.equal(e.store.polo_publish_verified_saved[''][421].source, 'page3_save_click');
    assert.equal(direct.messages[0].action, 'recordPublishSaveClick');
    assert.equal(direct.clicks.length, 0, '直接点平台保存仅记账，不二次点击');
    console.log('PASS 用户直接点平台保存也记已保存，不要求只能使用扩展菜单，不重复点击');
    await e.run('stopPublishTick()');
})().then(() => { clearTimeout(watchdog); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
