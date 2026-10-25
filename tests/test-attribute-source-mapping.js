const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'chrome_extension/content/page3.js'), 'utf8');
const html = fs.readFileSync(path.join(root, '发品助手.html'), 'utf8');
const ctx = {log() {}, console: {log() {}}, window: {}, document: {querySelectorAll: () => []}};
vm.createContext(ctx);
vm.runInContext(page.slice(page.indexOf('function buildAttributeFields('), page.indexOf('function detectFieldMode(')), ctx);
vm.runInContext(html.slice(html.indexOf('const HEADER_KEYWORDS_BY_CATEGORY ='), html.indexOf('function parseProducts(')), ctx);
const fields = product => {
    const result = ctx.buildAttributeFields({category: 'Non-hooded sweatshirt(5)', ...product});
    return Object.fromEntries([...result.required, ...result.optional].map(f => [f.lbl, f.val]));
};
// Real row 101 shape, including values parsed before the alias fix.
const oldRow = fields({fabric_type_en: 'Sweatshirt Fabric', fabric_en: '', printing_en: '',
    _attrs: [{label: '印花方式', en: 'None', cn: '无'}]});
assert.equal(oldRow['面料类型'], 'Sweatshirt Fabric');
assert.equal(oldRow['印花方法'], 'None');
assert.equal(fields({printing_en: 'None'})['印花方法'], 'None');
assert.equal(fields({printing_en: 'Screen Printing', _attrs: [{label: '印花方式', en: 'None'}]})['印花方法'], 'Screen Printing');
assert.equal(fields({fabric_en: 'Fleece'})['面料类型'], 'Fleece');
assert.equal(fields({fabric_type_en: 'Sweatshirt Fabric', fabric_en: 'Knitted'})['面料类型'], 'Sweatshirt Fabric');
assert.equal(fields({})['面料类型'], 'Knitted');
assert.equal(fields({})['印花方法'], 'Other');
for (const alias of ['印花方法', '印花方式']) {
    const map = ctx.buildColumnMap(['价格', '面料克重', '种类', '面料类型', alias, '标题']);
    assert.equal(map.fabric_type, 3);
    assert.equal(map.printing, 4);
    assert(!map._dynamic.some(a => a.col === 4));
}
console.log('Attribute source mapping: PASS (current loaded row, reimport aliases, explicit None, legacy fields and blank defaults)');
