// 页3 SKU 表筛选守卫：确保批量库存/尺码勾选不会误伤 SKU 表
// 结构断言（读源码）+ 行为断言（vm 沙箱跑真实函数片段）
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE3_PATH = path.join(__dirname, '..', 'chrome_extension', 'content', 'page3.js');
const COMMON_PATH = path.join(__dirname, '..', 'chrome_extension', 'content', 'common.js');

const page3Src = fs.readFileSync(PAGE3_PATH, 'utf-8');
const commonSrc = fs.readFileSync(COMMON_PATH, 'utf-8');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log(`  ✓ ${msg}`);
        passed++;
    } else {
        console.log(`  ✗ ${msg}`);
        failed++;
    }
}

function count(source, needle) {
    return source.split(needle).length - 1;
}

// 按函数切片：从函数头切到下一个分隔注释/下一个函数
function sliceFn(source, header, nextMarker) {
    const start = source.indexOf(header);
    if (start < 0) return '';
    const end = source.indexOf(nextMarker, start + header.length);
    return end < 0 ? source.slice(start) : source.slice(start, end);
}

const BATCH_FN = sliceFn(page3Src, 'async function fillBatchQtyPage3(', '// ============================================================');
const COLORS_FN = sliceFn(page3Src, 'async function fillColorsPage3(', '// ============================================================');
const SIZES_FN = sliceFn(page3Src, 'async function fillSizesPage3(', '// ============================================================');
const ALL_FN = sliceFn(page3Src, 'async function fillAllPage3(', 'function createPage3Panel');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ============================================================
// 1. 批量库存不再有坐标盲点点击
// ============================================================
test('批量库存无坐标盲点', () => {
    assert(BATCH_FN.length > 0, 'fillBatchQtyPage3 函数切片非空');
    assert(!BATCH_FN.includes('elementFromPoint'), 'fillBatchQtyPage3 内无 elementFromPoint');
    assert(!BATCH_FN.includes('realClick'), 'fillBatchQtyPage3 内无 realClick（不再盲点表格/输入框右侧）');
    assert(count(page3Src, 'elementFromPoint') === 0, 'page3.js 全文 elementFromPoint 命中数为 0');
    assert(count(commonSrc, 'elementFromPoint') === 0, 'common.js 全文 elementFromPoint 命中数为 0');
    assert(/nativeKeyPress\(['"]Tab['"]\)/.test(BATCH_FN), '保留 Tab 移焦提交');
    assert(BATCH_FN.includes('pressEnter(batchInput)'), '保留 Enter 提交');
    assert(BATCH_FN.includes('batchInput.blur()'), '保留 blur 兜底');
    assert(/activeAfterTab[\s\S]*?\.blur\(\)/.test(BATCH_FN), 'Tab 后焦点若落在可编辑单元格上会主动 blur');
});

// ============================================================
// 2. 批量库存只跑一次
// ============================================================
test('批量库存只跑一次', () => {
    assert(!COLORS_FN.includes('fillBatchQtyPage3'), 'fillColorsPage3 内不再调用 fillBatchQtyPage3');
    assert(COLORS_FN.includes('批量库存由'), 'fillColorsPage3 改为提示库存由批量编辑步骤统一执行');

    const colorsStepRe = /run\(['"]fill_colors['"]\)/g;
    const batchStepRe = /run\(['"]fill_batch_qty['"]\)/g;
    const colorsMatches = ALL_FN.match(colorsStepRe) || [];
    const batchMatches = ALL_FN.match(batchStepRe) || [];
    assert(colorsMatches.length === 1, 'fillAllPage3 中 fill_colors 步骤出现且仅出现 1 次');
    assert(batchMatches.length === 1, 'fillAllPage3 中 fill_batch_qty 步骤出现且仅出现 1 次');

    const colorsAt = ALL_FN.search(/run\(['"]fill_colors['"]\)/);
    const batchAt = ALL_FN.search(/run\(['"]fill_batch_qty['"]\)/);
    assert(colorsAt >= 0 && batchAt > colorsAt, 'fill_colors 在 fill_batch_qty 之前');

    assert(count(page3Src, 'await fillBatchQtyPage3(') === 1, 'page3.js 中 fillBatchQtyPage3 只有一个 await 调用点');
    const onlyCallAt = page3Src.indexOf('await fillBatchQtyPage3(');
    assert(onlyCallAt > page3Src.indexOf('async function fillAllPage3(') &&
        onlyCallAt < page3Src.indexOf('function createPage3Panel('),
        '唯一调用点位于 fillAllPage3 内');
});

// ============================================================
// 3. 原生 setter 写入（绕 React value tracker）
// ============================================================
test('批量库存走原生 setter', () => {
    assert(BATCH_FN.includes('setInputValue('), 'fillBatchQtyPage3 使用 setInputValue');
    assert(!BATCH_FN.includes('batchInput.value ='), '不再直接赋值 batchInput.value = ...');
    assert(!BATCH_FN.includes('batchInput.value +='), '不再逐字累加 batchInput.value += ...');
    assert(!/batchInput\.value\s*(\+=|=)/.test(BATCH_FN), '函数体内不存在任何 batchInput.value 直接写入');
    // 映射成功校验不能被顺手删掉
    assert(BATCH_FN.includes('.cell-skuStock input[value="10000"]'), '保留按 10000 值统计已映射单元格');
    assert(BATCH_FN.includes('请手动检查可售数量'), '保留映射失败时的人工核对提示');
});

// ============================================================
// 4. 颜色下拉浮层关闭方式（沙箱兼容，不依赖 closeOverlays）
// ============================================================
test('颜色步骤自行关闭下拉浮层', () => {
    assert(/KeyboardEvent\([^)]*Escape/.test(COLORS_FN), 'fillColorsPage3 派发 Escape keydown');
    assert(/new MouseEvent\(['"]mousedown['"]/.test(COLORS_FN), 'fillColorsPage3 在 body 上派发 mousedown');
    assert(/new MouseEvent\(['"]click['"]/.test(COLORS_FN), '同时补发 click，覆盖只监听 click 的浮层');
    assert(!COLORS_FN.includes('closeOverlays('), '不调用 closeOverlays（避免只加载片段时 ReferenceError）');
    assert(/try\s*\{[\s\S]{0,400}?Escape[\s\S]{0,800}?\}\s*catch/.test(COLORS_FN),
        '关浮层包在 try/catch 内，失败不影响后续颜色填充');
});

// ============================================================
// 5. 尺码勾选排除表头筛选浮层
// ============================================================
test('尺码勾选排除筛选浮层', () => {
    assert(SIZES_FN.includes('closest('), 'fillSizesPage3 用 closest 判断所属层级');
    const selectorMatch = SIZES_FN.match(/el\.closest\('([^']+)'\)/);
    const selector = selectorMatch ? selectorMatch[1] : '';
    assert(selector.length > 0, '能取到 closest 的排除选择器');
    ['thead', 'next-table-header', 'next-overlay-wrapper', 'next-table-fixed', 'filter']
        .forEach(token => assert(selector.includes(token), `排除选择器含 ${token}`));
    assert(SIZES_FN.includes('norm('), '尺码比较走 norm 归一化');
    assert(/replace\(\/\\s\+\/g/.test(SIZES_FN), '归一化会去掉空格（2 XL ↔ 2XL）');
    assert(SIZES_FN.includes("document.querySelectorAll('.next-checkbox-wrapper .next-checkbox-label')"),
        '仍保留全局扫描（不依赖 .next-checkbox-group 结构）');
});

// ============================================================
// 6. 死代码已清理
// ============================================================
test('删除无调用点的 clickBlankNear', () => {
    assert(!commonSrc.includes('clickBlankNear'), 'common.js 全文不含 clickBlankNear');
    assert(!page3Src.includes('clickBlankNear'), 'page3.js 全文不含 clickBlankNear');
    assert(commonSrc.includes('function realClick('), '只删了死函数，realClick 仍在');
    assert(commonSrc.includes('function setInputValue('), 'setInputValue 仍在');
    assert(commonSrc.includes('function nativeMouseClick('), 'nativeMouseClick 仍在');
});

// ============================================================
// 行为沙箱：模拟 DOM 祖先链匹配简单选择器
// ============================================================
function matchSimpleToken(node, token) {
    if (!node) return false;
    const classes = node.classes || [];
    if (token[0] === '.') return classes.includes(token.slice(1));
    if (token[0] === '[') {
        const m = token.match(/^\[class\*=["']?([^"'\]]+)["']?\]$/);
        return m ? classes.some(c => c.includes(m[1])) : false;
    }
    return String(node.tag || '').toLowerCase() === token.toLowerCase();
}

function makeNode(desc) {
    const node = {
        tag: desc.tag || 'div',
        classes: desc.classes || [],
        parent: desc.parent || null,
        text: desc.text || '',
        innerText: desc.text || ''
    };
    node.closest = selector => {
        const tokens = String(selector).split(',').map(s => s.trim()).filter(Boolean);
        for (let cur = node; cur; cur = cur.parent) {
            if (tokens.some(tok => matchSimpleToken(cur, tok))) return cur;
        }
        return null;
    };
    return node;
}

// ============================================================
// 7. 行为：表头筛选浮层里的同名尺码不会被勾选
// ============================================================
test('行为：只勾正常尺码组，不勾筛选浮层', async () => {
    const clicks = [];
    const labels = [];

    function addCheckbox(layer, text, ancestorDescs, checked) {
        let parent = makeNode({ tag: 'body' });
        ancestorDescs.forEach(desc => { parent = makeNode(Object.assign({}, desc, { parent })); });
        const wrapper = makeNode({ tag: 'label', classes: ['next-checkbox-wrapper'], parent, text });
        if (checked) wrapper.classes.push('checked');
        wrapper.classList = { contains: cls => wrapper.classes.includes(cls) };
        wrapper.click = () => clicks.push(`${layer}:${text}`);
        const label = makeNode({ tag: 'span', classes: ['next-checkbox-label'], parent: wrapper, text });
        labels.push(label);
    }

    const NORMAL = [{ tag: 'div', classes: ['next-checkbox-group'] }, { tag: 'div', classes: ['sell-o-size'] }];
    // 正常尺码组：页面文案是 XL / 2XL（无空格），配置是 Xl / 2 XL，必须靠 norm 才能匹配
    ['S', 'M', 'L', 'XL', '2XL', '3XL'].forEach(t => addCheckbox('normal', t, NORMAL, t === 'M'));
    // 表头筛选浮层：五种被排除的祖先各来一个，文案与正常组同名
    const LAYERS = [
        [{ tag: 'div', classes: ['next-table-header'] }],
        [{ tag: 'thead' }],
        [{ tag: 'div', classes: ['next-overlay-wrapper'] }],
        [{ tag: 'div', classes: ['next-table-fixed'] }],
        [{ tag: 'div', classes: ['sku-filter-column'] }],
        [{ tag: 'div', classes: ['next-overlay-wrapper'] }]
    ];
    ['S', 'M', 'L', 'XL', '2XL', '3XL'].forEach((t, i) => addCheckbox('overlay', t, LAYERS[i], false));

    const context = vm.createContext({
        document: {
            querySelector: () => null,
            querySelectorAll: () => labels
        },
        sleep3: async () => {},
        scrollAndFind: async callback => callback(),
        log() {}
    });
    vm.runInContext(SIZES_FN, context);
    const result = await context.fillSizesPage3({});

    assert(result[0].startsWith('✅ 尺码'), '尺码步骤返回成功提示');
    assert(clicks.every(c => c.startsWith('normal:')), '浮层里的同名复选框一个都没被点');
    assert(clicks.length === 5, `只点未选中的 5 个正常尺码（实际: ${clicks.length}）`);
    assert(clicks.join(',') === 'normal:S,normal:L,normal:XL,normal:2XL,normal:3XL',
        `按 S/L/XL/2XL/3XL 勾选且跳过已选中的 M（实际: ${clicks.join(',')}）`);
});

// ============================================================
// 7b. 行为：尺码全部被筛选浮层排除时，不能再无条件报成功
// ============================================================
test('行为：尺码命中 0 时不报成功', async () => {
    const clicks = [];
    const labels = [];

    function addCheckbox(text) {
        const header = makeNode({ tag: 'div', classes: ['next-table-header'], parent: makeNode({ tag: 'body' }) });
        const wrapper = makeNode({ tag: 'label', classes: ['next-checkbox-wrapper'], parent: header, text });
        wrapper.classList = { contains: cls => wrapper.classes.includes(cls) };
        wrapper.click = () => clicks.push(text);
        labels.push(makeNode({ tag: 'span', classes: ['next-checkbox-label'], parent: wrapper, text }));
    }

    // 六个尺码全在表头筛选浮层里（模拟排除过宽：正常组容器类名带 filter）
    ['S', 'M', 'L', 'XL', '2XL', '3XL'].forEach(addCheckbox);

    const context = vm.createContext({
        document: {
            querySelector: () => null,
            querySelectorAll: () => labels
        },
        sleep3: async () => {},
        scrollAndFind: async callback => callback(),
        log() {}
    });
    vm.runInContext(SIZES_FN, context);
    const result = await context.fillSizesPage3({});

    assert(clicks.length === 0, '浮层尺码一个都没被点');
    assert(!result[0].startsWith('✅'), `命中 0 时不再报 ✅（实际: ${result[0]}）`);
    assert(result[0].includes('尺码未勾选任何一项'), '输出未勾选任何一项的提示');
    assert(result[0].includes('请手动检查'), '提示引导人工核对');
});

// ============================================================
// 8. 行为：setInputValue 绕过 React value tracker
// ============================================================
test('行为：setInputValue 触发受控输入变化', () => {
    const svStart = commonSrc.indexOf('function setInputValue(');
    const cfStart = commonSrc.indexOf('function confirmInput(');
    const cfEnd = commonSrc.indexOf('\n}', cfStart) + 2;
    assert(svStart >= 0 && cfStart > svStart && cfEnd > cfStart, '能从 common.js 切出 setInputValue + confirmInput');

    class FakeEvent {
        constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); }
    }
    const context = vm.createContext({ Event: FakeEvent, MouseEvent: FakeEvent });
    vm.runInContext(commonSrc.slice(svStart, cfEnd), context);

    class RawInput {
        constructor() { this._raw = ''; }
        get value() { return this._raw; }
        set value(v) { this._raw = String(v); }
    }

    // 复刻 React 的受控输入：实例上覆盖 value 描述符，赋值时同步 tracker
    function makeTrackedInput() {
        const el = new RawInput();
        const protoDesc = Object.getOwnPropertyDescriptor(RawInput.prototype, 'value');
        let tracked = '';
        Object.defineProperty(el, 'value', {
            configurable: true,
            get() { return protoDesc.get.call(el); },
            set(v) { tracked = String(v); protoDesc.set.call(el, v); }
        });
        el.tracker = () => tracked;
        el.events = [];
        el.dispatchEvent = ev => el.events.push({ type: ev.type, value: el.value });
        return el;
    }

    // 直接赋值：tracker 同步更新 → React 判定"值未变化"，不提交
    const direct = makeTrackedInput();
    direct.value = '10000';
    const directCommits = direct.value === direct.tracker() ? [] : [direct.value];
    assert(directCommits.length === 0, '直接赋值会被 tracker 吞掉（模拟基线行为）');
    assert(direct.events.length === 0, '直接赋值不发 input/change 事件');

    // setInputValue：绕过实例 setter → tracker 仍是旧值 → React 判定有变化
    const controlled = makeTrackedInput();
    const ok = context.setInputValue(controlled, '10000');
    assert(ok === true, 'setInputValue 返回 true');
    assert(controlled.value === '10000', '原生 setter 把值写进真实 DOM 属性');
    assert(controlled.tracker() === '', 'tracker 保持旧值（React 才会认为值变了）');

    const commits = [];
    if (controlled.value !== controlled.tracker()) commits.push(controlled.value);
    assert(commits.length === 1 && commits[0] === '10000', 'onChange 判定有变化并提交新值');

    const inputEvent = controlled.events.find(e => e.type === 'input');
    const changeEvent = controlled.events.find(e => e.type === 'change');
    assert(inputEvent && inputEvent.value === '10000', 'input 事件携带新值 10000');
    assert(changeEvent && changeEvent.value === '10000', 'change 事件携带新值 10000');
});

(async () => {
    for (const [name, fn] of tests) {
        console.log(`\n[${name}]`);
        try {
            await fn();
        } catch (error) {
            console.log(`  ✗ 用例异常: ${error.message}`);
            failed++;
        }
    }
    console.log(`\n========== 测试结果 ==========`);
    console.log(`通过: ${passed}, 失败: ${failed}`);
    if (failed > 0) process.exit(1);
})();
