const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(__dirname + '/test-publish-queue.js', 'utf8');
const ctx = { require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, AbortController, TextDecoder, process };
vm.createContext(ctx); vm.runInContext(source.slice(0, source.indexOf('(async function main()')), ctx);
const e = vm.runInContext('createEnv()', ctx);
(async () => {
    const internal = await e.sendInternal({ action: 'unknown_old_action' });
    assert.equal(internal.ok, false); assert.match(internal.error, /未知消息/);
    const external = await e.sendExternal({ action: 'unknown_old_action' });
    assert.equal(external.ok, false); assert.match(external.error, /未知消息/);
    await e.run('ensureConfigLoaded = () => Promise.reject(new Error("配置读取失败"))');
    const heartbeat = await e.sendInternal({ action: 'heartbeat' });
    assert.equal(heartbeat.ok, false); assert.equal(heartbeat.error, '配置读取失败');
    console.log('PASS 内部/外部未知动作均明确回复，心跳初始化失败也回复，不遗留等待通道');
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
