// 使用真实助手页轮询函数：直接通知丢失时仍同步保存标记与待保存数量。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../发品助手.html'), 'utf8');
const lines = html.split('\n');
const start = lines.findIndex(l => l.startsWith('function startUploadPolling('));
const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
let tick, callback, requested, file = 'A__', refreshes = 0, updates = 0;
const oldBadge = { textContent: '历史待核', style: { opacity: '0.55' }, title: '旧标记', removeAttribute(key) { delete this[key]; } };
const card = { dataset: { idx: '0' }, querySelector: () => oldBadge };
const ctx = {
    products: [{ row: 5 }], uploadPollTimer: null, uploadedRows: {}, legacyRows: {}, EXTENSION_ID: 'test',
    currentFileKey: () => file, clearInterval() {}, setInterval(fn) { tick = fn; return 1; },
    refreshPublishState() { refreshes++; }, updateBatchBar() { updates++; },
    chrome: { runtime: { sendMessage(id, msg, cb) { requested = msg; callback = cb; } } },
    document: { getElementById: () => ({ querySelectorAll: () => [card] }) }
};
vm.createContext(ctx); vm.runInContext(lines.slice(start, end + 1).join('\n'), ctx);
ctx.startUploadPolling(); tick();
assert.equal(requested.fileKey, 'A__'); assert.equal(refreshes, 1, '每次轮询刷新进度数量');
callback({ ok: true, fileKey: 'A__', rows: { 5: { source: 'page3_save_click' } }, legacy: { 5: true } });
assert.equal(oldBadge.textContent, '已保存', '历史待核标签必须替换');
assert.equal(oldBadge.style.opacity, ''); assert.equal(oldBadge.title, undefined);
assert(ctx.uploadedRows[5]); assert.equal(updates, 1, '跳过已保存筛选使用最新记录');
tick(); file = 'B__'; callback({ ok: true, fileKey: 'A__', rows: { 9: true } });
assert.equal(ctx.uploadedRows[9], undefined, '切文件后的旧回调不得覆盖');
tick(); callback({ ok: true, fileKey: 'A__', rows: { 9: true } });
assert.equal(ctx.uploadedRows[9], undefined, '错误文件响应拒绝');
console.log('PASS 通知丢失时轮询仍替换历史标签、刷新待保存数量、更新跳过依据；切文件与错误文件响应隔离');
