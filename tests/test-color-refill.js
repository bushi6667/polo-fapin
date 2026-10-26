const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const page = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8');

const start = page.indexOf('async function fillColorsPage3(');
const end = page.indexOf('// ============================================================', start);
const allStart = page.indexOf('async function fillAllPage3(');
const allEnd = page.indexOf('function createPage3Panel', allStart);
const COLOR_FN = page.slice(start, end);
const ALL_FN = page.slice(allStart, allEnd);

// 只用于填充 KeyboardEvent/MouseEvent/Event 三个构造器，行为断言不依赖浏览器语义
class FakeEvent {
    constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts || {});
    }
}

function createSandbox(initial, remount = false) {
    let adds = 0;
    const counters = { stock: 0, colors: 0, order: [] };
    const dispatched = [];
    const rect = () => ({ width: 100, height: 20 });
    const section = { scrollIntoView() {}, getBoundingClientRect: rect };
    const image = { getAttribute: () => 'existing-image.png' };
    const item = { querySelectorAll: () => [image] };
    const body = { dispatchEvent: ev => { dispatched.push(ev); } };
    let active = null;

    function input(value) {
        return {
            value, scrollIntoView() {}, getBoundingClientRect: rect,
            closest: selector => selector.includes('struct-saleProp') ? section : item,
            focus() { active = this; }, select() {}, setSelectionRange() {}, blur() { active = null; },
            dispatchEvent(ev) { dispatched.push(ev); }
        };
    }

    const inputs = initial.map(input);
    const document = {
        body,
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

    // fillAllPage3 的其它步骤全部打桩，只保留真实的 fillColorsPage3，
    // 这样能验证「全流程里批量库存只跑一次」
    const stubs = {
        fillImagesPage3: async () => { counters.order.push('fill_images'); return ['✅ 主图']; },
        fillTitlePage3: async () => { counters.order.push('fill_title'); return ['✅ 标题']; },
        fillGroupPage3: async () => ['✅ 分组'],
        fillAttributesPage3: async () => ['✅ 属性'],
        fillSizesPage3: async () => { counters.order.push('fill_sizes'); return ['✅ 尺码']; },
        fillSizeTemplate: async () => ['✅ 尺码模板'],
        fillPriceUnitPage3: async () => ['✅ 价格单位'],
        fillLadderPricePage3: async () => ['✅ 阶梯价'],
        fillBatchQtyPage3: async () => {
            counters.stock++;
            counters.order.push('fill_batch_qty');
            return ['✅ 库存'];
        },
        fillLogisticsTemplate: async () => ['✅ 物流模板'],
        fillLogisticsPage3: async () => ['✅ 物流'],
        fillBoxRule: async () => ['✅ 箱规'],
        fillDetailTemplate: async () => ['✅ 商品详情模板: 已应用'],
        fillDetailImagesPage3: async () => ['✅ 详情图'],
        fillCompanyIntroTemplate: async () => ['✅ 公司介绍']
    };

    const context = vm.createContext(Object.assign({}, stubs, {
        document, sleep3: async () => {}, realClick: async () => {},
        scrollAndFind: async callback => callback(), log() {},
        setInputValue: (el, value) => { el.value = value; },
        KeyboardEvent: FakeEvent, MouseEvent: FakeEvent, Event: FakeEvent
    }));

    vm.runInContext(COLOR_FN + '\n' + ALL_FN, context);

    // 给真实 fillColorsPage3 套一层计数，用于验证调用顺序与次数
    const realFillColors = context.fillColorsPage3;
    context.fillColorsPage3 = async product => {
        counters.colors++;
        counters.order.push('fill_colors');
        return realFillColors(product);
    };

    return { context, counters, inputs, dispatched, adds: () => adds };
}

// 单个颜色步骤：只填颜色，不碰批量库存
async function run(initial, remount = false) {
    const sandbox = createSandbox(initial, remount);
    const result = await sandbox.context.fillColorsPage3({});
    if (initial.length > 4) {
        assert.equal(sandbox.adds(), 0);
        assert.match(result[0], /^⚠️/);
        return;
    }
    assert.deepEqual(sandbox.inputs.map(x => x.value), ['White', 'Black', 'Gray', 'Navy']);
    assert.equal(sandbox.adds(), Math.max(0, 4 - initial.length));
    assert.match(result[0], /^✅/);

    // 颜色步骤不再自己触发批量库存：库存只由 fill_all 的 fill_batch_qty 步骤统一执行
    assert.equal(sandbox.counters.stock, 0, '颜色步骤不应再调用 fillBatchQtyPage3');
    assert.ok(result.some(line => /批量库存.*批量编辑10000/.test(line)), '颜色步骤应留下「库存由批量编辑步骤统一执行」的提示');

    if (remount) {
        // 关浮层必须真的执行到，不能被 try/catch 静默吞掉
        assert.ok(sandbox.dispatched.some(ev => ev.key === 'Escape'), '改色后应派发 Esc 关闭下拉浮层');
        assert.ok(sandbox.dispatched.some(ev => ev.type === 'mousedown'), '关浮层应派发 body mousedown');
    }
}

// 全流程：fill_colors + fill_batch_qty 各一次，批量库存总数必须为 1
async function runFullFlow(initial, remount = false) {
    const sandbox = createSandbox(initial, remount);
    const result = await sandbox.context.fillAllPage3({}, undefined);
    const flowOrder = sandbox.counters.order.filter(step => step === 'fill_colors' || step === 'fill_batch_qty');
    assert.deepEqual(flowOrder, ['fill_colors', 'fill_batch_qty'], '全流程必须先填颜色再批量库存，且各一次');
    assert.equal(sandbox.counters.colors, 1, 'fill_colors 只应执行一次');
    assert.equal(sandbox.counters.stock, 1, '全流程批量库存只允许执行一次');
    assert.ok(result.some(line => /全部字段处理完毕/.test(line)), '全流程应正常走完');
}

(async () => {
    await run(['White', 'Black', 'Gray', 'Navy']);
    await run(['White', 'ck', 'Gray', ''], true);
    await run(['White', 'Black', 'Gray']);
    await run(['White', 'Black', 'Gray', 'Navy', '']);

    await runFullFlow(['White', 'Black', 'Gray', 'Navy']);
    await runFullFlow(['White', 'ck', 'Gray', ''], true);

    console.log('PASS: repeated color fill keeps images and row count, repairs truncated text across remount, closes the color dropdown without triggering SKU stock, and fill_all runs batch stock exactly once');
})().catch(error => { console.error(error); process.exitCode = 1; });
