const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');
const start = source.indexOf('async function setSimpleSelect(');
const end = source.indexOf('async function setSearchDropdownPage3(', start);

async function run(texts, expected, label = '徽标位置', value = 'Back') {
    const picked = [];
    const trigger = { dispatchEvent() {} };
    const options = texts.map(innerText => ({ innerText, offsetHeight: 20, offsetWidth: 100, scrollIntoView() {} }));
    const popup = { scrollTop: 0 };
    const context = vm.createContext({
        sleep3: async () => {}, log() {}, confirmInput() {}, KeyboardEvent: class {}, FocusEvent: class {},
        nativeMouseClick: element => { if (options.includes(element)) picked.push(element.innerText); },
        document: {
            body: { dispatchEvent() {} },
            querySelector: () => popup,
            querySelectorAll: selector => selector.includes('.options-item') ? options : []
        }
    });
    vm.runInContext(source.slice(start, end), context);
    const result = await context.setSimpleSelect({ scrollIntoView() {}, querySelector: () => trigger }, value, label, 'Front');
    assert.equal(result.ok, expected !== null);
    assert.deepEqual(picked, expected === null ? [] : [expected]);
}
(async () => {
    await run(['back neck', 'back'], 'back');
    await run(['back neck', 'Front'], null);
    await run(['back\n\ue6c1'], 'back\n\ue6c1');
    await run(['Regular Sleeve'], 'Regular Sleeve', '袖型', 'Regular');
    console.log('PASS: Back cannot become back neck or Front; exact choice and selected icon work; other field matching remains compatible');
})().catch(error => { console.error(error); process.exitCode = 1; });
