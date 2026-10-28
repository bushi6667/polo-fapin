const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');
const start = source.indexOf('function getAssociatedBoxRule()');
const end = source.indexOf('// ============================================================', source.indexOf('async function fillBoxRule('));

async function run(displayed, hidden, reportedOk, timeout = false, ruleText) {
    let visible = false, listener, deadline, cleared = 0;
    const rule = {
        innerText: ruleText || '50*40*30: 长*宽*高 | 箱规可装最大商品数量（件/批） 25件/批',
        getBoundingClientRect: () => ({ width: hidden ? 0 : 100, height: hidden ? 0 : 20 })
    };
    const frame = {
        src: 'https://scm.alibaba.com/luyou/express/template_relate_package_dialog.htm',
        getBoundingClientRect: () => ({ height: 560 })
    };
    const context = vm.createContext({
        document: { querySelectorAll: selector => selector === 'iframe' ? [frame] : visible ? [rule] : [] },
        sleep3: async () => {},
        setInterval: () => 1, clearInterval: () => { cleared++; },
        setTimeout: callback => { deadline = callback; return 2; },
        clearTimeout: () => { cleared++; },
        chrome: { runtime: {
            lastError: null,
            onMessage: { addListener: callback => { listener = callback; }, removeListener: () => { listener = null; } },
            sendMessage: (_, callback) => callback({ ok: true })
        } }
    });
    vm.runInContext(source.slice(start, end), context);
    const pending = context.fillBoxRule({});
    for (let i = 0; i < 10 && !listener; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof listener, 'function');
    visible = displayed;
    if (timeout) deadline();
    else listener({ action: 'fillBoxRuleResult', result: { ok: reportedOk, error: 'message channel closed' } });
    const result = await pending;
    assert.equal(result[0].startsWith('✅'), displayed && !hidden);
    assert.equal(cleared, 2);
    assert.equal(listener, null);
    if (displayed && !hidden) {
        deadline();
        assert.equal(result.length, 1);
    }
}

async function runDialog(first, second, disabled = false, directList = false, resumeList = false, finishText = '确认完成', missingFinal = false, associated = false, confirmCancellation = false) {
    let stage = 0, listener, quantity = '', manual = false, multiple = false;
    class Input {
        get value() { return quantity; }
        set value(value) { quantity = value; }
        focus() {} blur() {} dispatchEvent() {}
    }
    if (resumeList) stage = 3;
    const input = new Input();
    function element(text, button, click) {
        return {
            innerText: text, textContent: text, offsetParent: {},
            disabled: disabled && text === '关联',
            classList: { contains: () => false }, matches: () => button,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
            dispatchEvent: event => { if (event.type === 'click') click(); }
        };
    }
    const radios = [element('手动设置', false, () => { manual = true; }), element('一箱多件', false, () => { multiple = true; })];
    const buttons = [
        element(first, true, () => { if (manual) stage = 1; }),
        element(second, true, () => { if (multiple) stage = directList ? 3 : 2; }),
        element('下一步', true, () => { stage = 3; }),
        element('关联', true, () => { assert.equal(quantity, '25'); stage = 4; }),
        element(finishText, true, () => { stage = 5; })
    ];
    if (finishText === '确认运费') buttons.push(element('确认完成', true, () => { stage = 6; }));
    let cancellationPending = false;
    const cancelButton = element('取消关联', true, () => {
        if (confirmCancellation) cancellationPending = true;
        else associated = false;
    });
    const confirmCancelButton = element('确定', true, () => { associated = false; cancellationPending = false; });
    const cancelDialog = { innerText: '确认取消关联？', offsetParent: {}, querySelectorAll: () => [confirmCancelButton] };
    const row = { innerText: '50*40*30', querySelector: () => associated ? null : input,
        querySelectorAll: () => associated ? [cancelButton] : [buttons[3]] };
    const context = vm.createContext({
        window: {}, console: { log() {} }, HTMLInputElement: Input,
        Event: class { constructor(type) { this.type = type; } },
        MouseEvent: class { constructor(type) { this.type = type; } },
        setTimeout: callback => callback(),
        chrome: { runtime: { onMessage: { addListener: callback => { listener = callback; } } } },
        document: { querySelectorAll: selector => {
            if (selector === '.next-dialog') return cancellationPending ? [cancelDialog] : [];
            if (selector === 'tr, .next-table-row') return stage === 3 ? [row] : [];
            if (selector === 'button' || selector === '.next-btn') return stage < (finishText === '确认运费' && !missingFinal ? 6 : 5) ? [buttons[stage]] : [];
            if (selector === 'label' || selector.includes('radio')) return stage < 2 ? [radios[stage]] : [];
            return [];
        } }
    });
    vm.runInContext(fs.readFileSync(__dirname + '/../chrome_extension/content/boxRuleIframe.js', 'utf8'), context);
    const result = await new Promise(resolve => listener({ action: 'fillBoxRuleIframe' }, {}, resolve));
    assert.equal(result.ok, !disabled && !missingFinal);
    assert.equal(stage, disabled ? 3 : finishText === '确认运费' && !missingFinal ? 6 : 5);
}

(async () => {
    await run(true, false, false);
    await run(true, false, true);
    // 件数文案因类目/模板而异：25 件 / 批、25件/箱、25 件 都应算关联成功
    await run(true, false, true, false, '50*40*30: 长*宽*高 | 箱规可装最大商品数量 25 件 / 箱');
    await run(true, true, true);
    await run(false, false, true);
    await run(false, false, false, true);
    await runDialog('确认', '下一步');
    await runDialog('下一步', '确认');
    await runDialog('确认', '下一步', true);
    await runDialog('确认', '下一步', false, true);
    await runDialog('确认', '下一步', false, false, true);
    await runDialog('确认', '下一步', false, true, false, '确认运费');
    await runDialog('确认', '下一步', false, false, true, '确认运费');
    await runDialog('确认', '下一步', false, true, false, '确认运费', true);
    await runDialog('确认', '下一步', false, false, true, '确认运费', false, true);
    await runDialog('确认', '下一步', false, false, true, '确认运费', false, true, true);
    console.log('PASS: 15 box rule scenarios including replacing an existing association with confirmation, both dialog button sequences, disabled association, closed channel, false success and deadline cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
