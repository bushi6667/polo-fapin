/**
 * 页3 属性值读取：下拉框的值在 .next-select-values 的 em 里，输入框只是搜索框（value 恒空）。
 * 真机现象：省份明明已显示 Zhejiang，却被判「值为空」→ 整行带 ⚠️ → 不自动保存。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const P3 = fs.readFileSync(path.join(ROOT, 'chrome_extension/content/page3.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFn(name) {
    const lines = P3.split('\n');
    const re = new RegExp('^function ' + name + '\\(');
    let s = -1;
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { s = i; break; }
    if (s < 0) throw new Error('未找到函数 ' + name);
    for (let j = s + 1; j < lines.length; j++) if (lines[j] === '}') return lines.slice(s, j + 1).join('\n');
    throw new Error('未闭合 ' + name);
}

let pass = 0, fail = 0; const bad = [];
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, bad.push(m), console.log('  ❌ ' + m + (extra ? ' :: ' + extra : ''))); };

const SRC = [extractFn('readSelectValueText'), extractFn('getFieldCurrentValue')].join('\n\n');

// 造一个和真机一致的「省份」容器：next-select + 搜索 input（value=''）+ em[title=Zhejiang]
function selectContainer(value) {
    const em = { getAttribute: (k) => (k === 'title' ? value : null), textContent: value, innerText: value };
    const valuesBox = { innerText: value, textContent: value, querySelector: () => em };
    const searchInput = { value: '' };
    const host = {
        // '.next-select-values em' / 'em[title]' 都返回 em；'.next-select-values' 返回 valuesBox
        querySelector: (sel) => (sel.indexOf(' em') >= 0 || sel.indexOf('em[title]') === 0 ? em : valuesBox),
        querySelectorAll: () => []
    };
    return {
        querySelectorAll: () => [],
        querySelector: (sel) => {
            if (sel === '.next-select, .next-select-trigger, .next-select-inner') return host;
            if (sel.indexOf('input') === 0) return searchInput;
            return null;
        }
    };
}
// 普通文本输入容器（无 next-select）
function textContainer(value) {
    const input = { value };
    return { querySelectorAll: () => [], querySelector: (sel) => (sel.indexOf('input') === 0 ? input : null) };
}

const sb = { console, String, Array, Object, Error };
vm.createContext(sb);
vm.runInContext(SRC, sb, { filename: 'page3.js:value-read' });

console.log('=== 页3 属性值读取 ===');
for (const mode of ['select', 'auto', 'direct', 'input', 'search']) {
    const v = sb.getFieldCurrentValue(selectContainer('Zhejiang'), mode);
    ok(v === 'Zhejiang', `下拉框按 ${mode} 都能读到 Zhejiang（不再误判为空）`, v);
}
{
    const v = sb.getFieldCurrentValue(selectContainer('Zhejiang'), 'tag');
    ok(v === '', 'tag 模式不受影响（仍走标签逻辑）', v);
}
{
    const v = sb.getFieldCurrentValue(textContainer('180GSM 纯棉'), 'direct');
    ok(v === '180GSM 纯棉', '普通输入框仍读 input.value', v);
}
{
    const v = sb.getFieldCurrentValue({ querySelector: () => null, querySelectorAll: () => [] }, 'auto');
    ok(v === '', '空容器返回空串，不抛错', v);
}
// 源码口径：auto/direct 分支前必须先读 select 值
ok(/const selectText = readSelectValueText\(container\);/.test(P3),
    'getFieldCurrentValue 先读下拉值再退回 input.value');
ok(/em\[title\]/.test(P3) && /next-select-values em/.test(P3),
    '同时认 em[title] 与 .next-select-values（类名变动也能读）');

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail) console.log('失败项：' + bad.join(' / '));
process.exit(fail ? 1 : 0);
