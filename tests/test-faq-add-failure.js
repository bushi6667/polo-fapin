const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');
const start = source.indexOf('function parseFaqs(');
const end = source.indexOf('async function saveDraft(', start);
let clicks = 0;
let waits = 0;
const container = {
    scrollIntoView() {},
    querySelectorAll: () => [],
    querySelector: () => ({ scrollIntoView() {} })
};
const context = vm.createContext({
    window: {}, document: {}, log() {},
    scrollAndFind: async () => container,
    realClick: async () => { clicks++; },
    sleep3: async () => { if (++waits > 50) throw Error('FAQ retry loop never ended'); }
});
vm.runInContext(source.slice(start, end), context);
(async () => {
    const result = await context.fillFaqsPage3({ faq: 'Q: Example? A: Answer.' }, 'overwrite');
    assert.equal(clicks, 1);
    assert(result.some(text => text.includes('添加条目未生效')));
    assert(result.some(text => text.includes('0/1')));
    assert(!result.some(text => text.startsWith('✅')));
    console.log('PASS: an ignored Add FAQ click ends with a failure, never hangs or claims success');
})().catch(error => { console.error(error); process.exitCode = 1; });
