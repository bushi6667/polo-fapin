// 真实后台保存、复查确认及队列函数，不用简化版队列替代。
const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(__dirname + '/test-save-verify.js', 'utf8');
const context = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, AbortController, TextDecoder, process };
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('(async () => {')), context);
const helpers = vm.runInContext('({backend,openTask,savedMapOf})', context);
(async () => {
    const { env } = helpers.backend();
    const { opened, sender } = await helpers.openTask(env);
    sender.url += '&itemId=123';
    sender.tab.url = sender.url;
    const token = { cycleId: 'cycle-123', attempt: 1 };
    const save = { action: 'savePublishProduct', row: 412, taskId: opened.taskId, itemId: '123', x: 10, y: 10,
        reviewCycle: token };
    let response = await env.sendInternal(save, sender);
    assert.equal(response.ok, true); assert.equal(response.verified, true); assert.equal(response.unverified, true);
    const entry = () => Object.values(helpers.savedMapOf(env)).map(rows => rows[412]).find(Boolean);
    assert.equal(entry().reviewPending, true); assert.equal(entry().reviewCycleId, token.cycleId);
    const product = await env.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: opened.taskId }, sender);
    assert.equal(product.reviewPending, true); assert.equal(product.autoFillAllowed, false);
    // 人为推进测试时钟，验证待复查记录不会被原超时自动跳过。
    env.store.polo_publish_task.currentStartedAt = Date.now() - env.store.polo_publish_task.rowTimeoutMs - 1000;
    await env.run('publishTickOnce()');
    assert.equal(env.store.polo_publish_task.state, 'paused');
    assert.equal(env.store.polo_publish_task.pauseReason, 'review_required');
    assert.equal(env.store.polo_publish_task.remaining[0], 412);
    const beforeRetry = env.tabs.length;
    const retry = await env.sendInternal({ action: 'retryPublishRow' }, sender);
    assert.equal(retry.ok, false); assert.equal(retry.itemId, '123'); assert.equal(env.tabs.length, beforeRetry);
    // 独立验证下面的普通运行中完成消息闸门，恢复夹具时钟，不操作真实浏览器。
    env.store.polo_publish_task.state = 'running';
    env.store.polo_publish_task.currentStartedAt = Date.now();
    const complete = { action: 'publishFilled', row: 412, taskId: opened.taskId, reviewCycle: token };
    response = await env.sendInternal(complete, sender);
    assert.equal(response.ok, false); assert.equal(env.store.polo_publish_task.remaining[0], 412);
    response = await env.sendInternal({ ...complete, skipped: true }, sender);
    assert.equal(response.ok, false); // 不能用“已保存跳过”绕过pending。
    response = await env.sendInternal({ ...complete, failed: true }, sender);
    assert.equal(response.ok, false); // 保存后才迟到的页2失败也不能移走当前行。
    const hold = { action: 'holdPublishReview', row: 412, taskId: opened.taskId, reason: 'unknown' };
    response = await env.sendInternal(hold, { ...sender, tab: { ...sender.tab, id: sender.tab.id + 999 } });
    assert.equal(response.ok, false); assert.equal(env.store.polo_publish_task.state, 'running');
    response = await env.sendInternal(hold, sender); assert.equal(response.ok, true);
    assert.equal(env.store.polo_publish_task.state, 'paused');
    assert.equal(env.store.polo_publish_task.currentTabId, sender.tab.id);
    assert.equal(env.store.polo_publish_task.remaining[0], 412);
    const finish = { action: 'finishPublishReview', row: 412, taskId: opened.taskId, itemId: '123', ...token };
    for (const change of [{ attempt: 2 }, { cycleId: 'old' }, { itemId: 'other' }, { taskId: 'other' }, { row: 415 }]) {
        response = await env.sendInternal({ ...finish, ...change }, sender);
        assert.equal(response.ok, false); assert.equal(entry().reviewPending, true);
    }
    response = await env.sendInternal(finish, { ...sender, tab: { ...sender.tab, id: sender.tab.id + 999 } });
    assert.equal(response.ok, false);
    response = await env.sendInternal(finish, { ...sender, frameId: 1 }); assert.equal(response.ok, false);
    response = await env.sendInternal(finish, sender); assert.equal(response.ok, true);
    assert.equal(entry().reviewPending, false); assert.equal(entry().reviewPassed, true); assert(!entry().unverified);
    response = await env.sendInternal(finish, sender); assert.equal(response.repeated, true);
    response = await env.sendInternal({ ...complete, reviewCycle: { ...token, attempt: 2 } }, sender);
    assert.equal(response.ok, false); assert.equal(env.store.polo_publish_task.remaining[0], 412);
    response = await env.sendInternal(complete, sender); assert.equal(response.ok, true);
    assert.equal(env.store.polo_publish_task.remaining[0], 415);
    response = await env.sendInternal(complete, sender); assert.equal(response.ok, false);
    assert.equal(env.store.polo_publish_task.remaining[0], 415);
    console.log('PASS real backend review gate: pending holds row, stale proof/task/item/tab/frame refused, finalization idempotent, one advancement');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
