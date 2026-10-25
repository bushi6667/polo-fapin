// 用真实任务入口复现截图中的容量失败；模拟容量规则，不声称浏览器实测。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, 'test-publish-queue.js'), 'utf8');
const context = { require, __dirname, console, setTimeout, clearTimeout, setInterval,
    clearInterval, URLSearchParams, AbortController, TextDecoder, process };
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('(async function main()')), context);
const quota = 10 * 1024 * 1024;
const rows = Array.from({ length: 600 }, (_, i) => i + 2);
const products = rows.map(row => ({ row, title_en: 'Product ' + row, description: 'x'.repeat(2048) }));
const existing = { previous_file_data: 'x'.repeat(9 * 1024 * 1024), uploaded: { 1: true } };
async function env(extra = {}) {
    context.options = { storageQuotaBytes: quota, initialStore: existing, ...extra };
    const e = vm.runInContext('createEnv(options)', context);
    await new Promise(resolve => setTimeout(resolve, 100));
    return e;
}

(async () => {
    assert(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'manifest.json'))).permissions.includes('unlimitedStorage'));
    const old = await env({ storagePermissions: ['storage'] });
    const rejected = await old.sendExternal({ action: 'openBatchPublish', rows, products, fileKey: '' });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /kQuotaBytes/);
    assert.equal(old.store.polo_publish_task, undefined);
    assert.equal(old.createdUrls.length, 0, '存储失败不得开页或假报启动');
    assert.equal(old.store.previous_file_data.length, existing.previous_file_data.length);
    await old.run('stopPublishTick()');
    console.log('PASS 原权限下复现600款容量错误，失败不启动、不清旧数据');

    const fixed = await env();
    const started = await fixed.sendExternal({ action: 'openBatchPublish', rows, products, fileKey: '' });
    assert.equal(started.ok, true);
    assert.equal(Object.keys(fixed.store.polo_publish_task.products).length, 600);
    context.activeEnv = fixed;
    assert.equal(await vm.runInContext('driveFills(activeEnv, 50)', context), 50);
    const status = await fixed.sendExternal({ action: 'getPublishState' });
    assert.equal(status.state, 'paused');
    assert.equal(status.pauseReason, 'batch');
    assert.equal(status.remaining, 550);
    assert.equal(fixed.createdUrls.length, 50);
    assert.equal(status.savedCount, 0);
    assert.equal(status.pendingSaveCount, 50);
    assert.equal(fixed.store.previous_file_data.length, existing.previous_file_data.length);
    assert.equal(fixed.store.uploaded[1], true);
    const resumed = vm.runInContext('createEnv({initialStore: activeEnv.store})', context);
    await new Promise(resolve => setTimeout(resolve, 150));
    const product = await resumed.sendInternal({ action: 'getProductByRow', rowNum: 601, taskId: started.taskId });
    assert.equal(product.data.title_en, 'Product 601', '冷启动仍保留后续批次产品快照');
    assert.equal(resumed.createdUrls.length, 0, '恢复不自动继续');
    await fixed.run('stopPublishTick()');
    await resumed.run('stopPublishTick()');
    console.log('PASS 当前权限下600款完整保存，50款暂停剩550，冷启动可读且保留原数据');
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
