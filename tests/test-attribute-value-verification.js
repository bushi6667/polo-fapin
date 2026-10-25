const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');
const context = vm.createContext({ getFieldCurrentValue: element => element.value });
vm.runInContext(source.slice(source.indexOf('function normalizeCompare('), source.indexOf('function getFieldCurrentValue(')), context);
vm.runInContext(source.slice(source.indexOf('function verifyFieldValue('), source.indexOf('async function fillAttributeField(')), context);
for (const mode of ['direct', 'input', 'auto']) {
    for (const [actual, expected] of [['MenMen', 'Men'], ['ck', 'Black'], ['2800', '280'], ['Cotton', '60% Cotton 40% Polyester']]) {
        assert.equal(context.verifyFieldValue({ value: actual }, expected, mode), false, `${mode}: ${actual} must not pass for ${expected}`);
    }
    assert.equal(context.verifyFieldValue({ value: ' men ' }, 'Men', mode), true);
    assert.equal(context.verifyFieldValue({ value: '60% Cotton 40% Polyester' }, '60% Cotton 40% Polyester', mode), true);
}
console.log('PASS: duplicated, truncated and partially matching text cannot pass attribute verification');
