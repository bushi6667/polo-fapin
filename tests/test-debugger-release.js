const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../chrome_extension/background.js'), 'utf8');
const click = source.slice(source.indexOf('async function realClickCDP('), source.indexOf('let doubaoTabId ='));
const upload = source.slice(source.indexOf('async function uploadDoubaoImage('), source.indexOf('async function downloadDoubaoImage('));

async function run(kind, failure) {
    const calls = [];
    const context = vm.createContext({
        console: { log() {}, error() {} },
        setTimeout: callback => callback(),
        chrome: {
            tabs: { sendMessage: async () => {}, query: async () => [{ id: 123 }] },
            debugger: {
                attach: async () => {
                    calls.push('attach');
                    if (failure === 'occupied') throw new Error('already attached');
                },
                sendCommand: async (_, command) => {
                    calls.push(command);
                    if (failure === 'occupied' || failure === 'command') throw new Error('command rejected');
                    if (command === 'DOM.getDocument') return { root: { nodeId: 1 } };
                    if (command === 'DOM.querySelectorAll') return { nodeIds: [2] };
                    if (command === 'DOM.describeNode') return { node: { nodeId: 2 } };
                    return { result: { value: null } };
                },
                detach: async () => { calls.push('detach'); }
            }
        }
    });
    vm.runInContext(click + '\n' + upload, context);
    const result = await (kind === 'click'
        ? context.realClickCDP(123, 10, 20)
        : context.uploadDoubaoImage(123, 'test.png'));
    assert.equal(calls.filter(x => x === 'detach').length, failure === 'occupied' ? 0 : 1);
    if (failure) assert.equal(result.ok, false);
    if (kind === 'click' && !failure) assert.equal(result.ok, true);
    if (kind === 'upload' && !failure) assert.equal(result.ok, true);
}

(async () => {
    for (const kind of ['click', 'upload']) {
        for (const failure of [null, 'command', 'occupied']) await run(kind, failure);
    }
    console.log('PASS: 6 debugger cleanup scenarios using production functions');
})().catch(error => { console.error(error); process.exitCode = 1; });
