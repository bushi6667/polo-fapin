const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const page = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');
const start = page.indexOf('async function fillColorsPage3(');
const end = page.indexOf('// ============================================================', start);

async function run(initial, remount = false) {
    let adds = 0, stock = 0, active = null;
    const rect = () => ({ width: 100, height: 20 });
    const section = { scrollIntoView() {}, getBoundingClientRect: rect };
    const image = { getAttribute: () => 'existing-image.png' };
    const item = { querySelectorAll: () => [image] };
    function input(value) {
        return { value, scrollIntoView() {}, getBoundingClientRect: rect,
            closest: selector => selector.includes('struct-saleProp') ? section : item,
            focus() { active = this; }, select() {}, setSelectionRange() {}, blur() { active = null; } };
    }
    const inputs = initial.map(input);
    const document = {
        get activeElement() { return active; },
        querySelector: selector => selector.includes('colorCombobox') ? inputs[0] : selector.includes('add-color-btn') ? { click() { adds++; inputs.push(input('')); } } : null,
        querySelectorAll: () => inputs,
        execCommand(command, _, text) {
            if (!active) return false;
            if (command === 'delete') active.value = '';
            if (command === 'insertText') active.value += text;
            if (remount) {
                const i = inputs.indexOf(active);
                inputs[i] = input(active.value);
                active = null;
            }
            return true;
        }
    };
    const context = vm.createContext({ document, sleep3: async () => {}, realClick: async () => {},
        scrollAndFind: async callback => callback(), log() {},
        setInputValue: (el, value) => { el.value = value; },
        fillBatchQtyPage3: async () => { stock++; return ['✅ 库存']; } });
    vm.runInContext(page.slice(start, end), context);
    const result = await context.fillColorsPage3({});
    if (initial.length > 4) {
        assert.equal(adds, 0); assert.match(result[0], /^⚠️/); return;
    }
    assert.deepEqual(inputs.map(x => x.value), ['White', 'Black', 'Gray', 'Navy']);
    assert.equal(adds, Math.max(0, 4 - initial.length));
    assert.equal(stock, initial.join(',') === 'White,Black,Gray,Navy' ? 0 : 1);
    assert.match(result[0], /^✅/);
}
(async () => {
    await run(['White', 'Black', 'Gray', 'Navy']);
    await run(['White', 'ck', 'Gray', ''], true);
    await run(['White', 'Black', 'Gray']);
    await run(['White', 'Black', 'Gray', 'Navy', '']);
    console.log('PASS: repeated color fill keeps images and row count, repairs truncated text across remount, resets changed SKU stock');
})().catch(error => { console.error(error); process.exitCode = 1; });
