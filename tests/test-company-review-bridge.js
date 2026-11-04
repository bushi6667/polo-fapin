const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(__dirname + '/test-save-verify.js', 'utf8');
const context = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, AbortController, TextDecoder, process };
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('(async () => {')), context);
const helpers = vm.runInContext('({backend,openTask})', context);
(async () => {
    const { env } = helpers.backend();
    vm.runInContext(fs.readFileSync(__dirname + '/../chrome_extension/content/page3-review-company.js', 'utf8'), env.ctx);
    const { sender, opened } = await helpers.openTask(env);
    sender.url += '&itemId=123'; sender.tab.url = sender.url;
    const calls = [];
    env.ctx.chrome.scripting.executeScript = async spec => {
        calls.push(spec); return [{ frameId: 0, result: { ok: true, applied: true, changed: ['companyDesc'] } }];
    };
    const request = { action: 'repairCompanyTemplateMissing', row: 412, taskId: opened.taskId,
        fileKey: env.store.polo_publish_task.fileKey, itemId: '123', origin: 1, deadline: Date.now() + 15000, label: 'Shirt' };
    for (const patch of [{ itemId: 'other' }, { origin: '1' }, { deadline: Date.now() - 1 },
        { deadline: Date.now() + 30000 }, { row: 0 }, { label: '' }, { taskId: 'other' }, { fileKey: 'other' }]) {
        assert.equal((await env.sendInternal({ ...request, ...patch }, sender)).ok, false);
    }
    assert.equal((await env.sendInternal(request, { ...sender, frameId: 1 })).ok, false);
    assert.equal((await env.sendInternal(request, { ...sender, url: 'https://example.com/product/publish?itemId=123' })).ok, false);
    assert.equal(calls.length, 0);
    assert.equal((await env.sendInternal(request, sender)).ok, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].world, 'MAIN');
    assert.equal(calls[0].func.name, 'applyMain'); assert.equal(calls[0].args[0].label, 'Shirt');
    assert.equal(calls[0].target.tabId, sender.tab.id);
    const unsaved = { ...sender, url: sender.url.replace('&itemId=123', '') };
    assert.equal((await env.sendInternal({ ...request, itemId: '' }, unsaved)).ok, true);
    assert.equal(calls[1].args[0].itemId, '');
    console.log('PASS real company bridge: top frame, item/document/deadline/task/file guards, isolated MAIN dispatch, unsaved product support');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
