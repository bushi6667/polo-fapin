const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');
const start = source.indexOf('async function fillLogisticsPage3(');
const end = source.indexOf('// ============================================================', start);

async function run(mode) {
    const rect = () => ({ width: 100, height: 20 });
    const input = name => ({ name, value: '', isConnected: true, offsetParent: {},
        getBoundingClientRect: rect, scrollIntoView() {}, focus() {}, dispatchEvent() {} });
    const fields = Object.fromEntries(['quantity', 'day', 'weight', '长', '宽', '高'].map(name => [name, input(name)]));
    const hidden = { ...input('hidden'), getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    const measure = { offsetParent: {}, offsetWidth: 100, offsetHeight: 20, scrollIntoView() {},
        querySelectorAll: () => ['长', '宽', '高'].map(label => ({
            querySelector: selector => selector === '.next-row:first-child' ? { textContent: label } : fields[label]
        })) };
    const section = { getBoundingClientRect: rect, scrollIntoView() {} };
    const property = { getBoundingClientRect: rect, querySelector: () => ({ textContent: 'Ordinary goods' }) };
    const context = vm.createContext({
        log() {}, sleep3: async () => {}, scrollAndFind: async callback => callback(),
        confirmInput() {}, pressEnter() {}, FocusEvent: class {}, Event: class {},
        setInputValue: (el, value) => { if (!(mode === 'rejected' && el.name === 'weight')) el.value = value; },
        document: { querySelectorAll: selector => {
            if (selector.includes('input-quantity')) return [hidden, fields.quantity];
            if (selector.includes('input-day')) return [hidden, fields.day];
            if (selector.includes('input#pkgWeight')) return mode === 'missing' ? [] : [hidden, fields.weight];
            if (selector.includes('pkgMeasure')) return [measure];
            if (selector.includes('logisticsProperty')) return [property];
            return [section];
        } }
    });
    vm.runInContext(source.slice(start, end), context);
    const result = await context.fillLogisticsPage3({});
    assert.equal(result.some(value => value.startsWith('✅ 物流信息:')), mode === 'valid');
    assert.equal(hidden.value, '');
    assert.equal(result.some(value => value.includes('物流属性已为普货')), true);
    if (mode !== 'valid') assert.equal(result.some(value => value.startsWith('⚠️')), true);
}
(async () => {
    await run('valid'); await run('missing'); await run('rejected');
    console.log('PASS: logistics ignores hidden inputs, verifies numeric values, accepts Ordinary goods, rejects missing/ineffective fill');
})().catch(error => { console.error(error); process.exitCode = 1; });
