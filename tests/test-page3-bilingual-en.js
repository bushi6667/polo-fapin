/**
 * 双语字段只取英文段。
 * 真机：Polo 的「产品特性」= "Soft, Breathable, Skin-Friendly / 柔软, 透气, 亲肤"，
 * 按逗号切会得到 "Skin-Friendly / 柔软"（匹配不到选项），还会把中文当英文值硬回车。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'chrome_extension/content/page3.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const bad = [];
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, bad.push(m), console.log('  ❌ ' + m + (extra ? ' :: ' + extra : ''))); };

const fn = SRC.match(/function pickEnglishPart\([\s\S]*?\n\}/);
if (!fn) { console.log('❌ 找不到 pickEnglishPart'); process.exit(1); }
const sb = { String };
vm.createContext(sb);
vm.runInContext(fn[0], sb);
const f = sb.pickEnglishPart;

console.log('=== 双语字段取英文段 ===');
ok(f('Soft, Breathable, Skin-Friendly / 柔软, 透气, 亲肤').trim() === 'Soft, Breathable, Skin-Friendly',
    '产品特性（真机取值）只留英文 3 项', f('Soft, Breathable, Skin-Friendly / 柔软, 透气, 亲肤'));
ok(f('Soft, Breathable').trim() === 'Soft, Breathable', '纯英文原样返回');
ok(f('100% Combed Cotton / 100%精梳棉').trim() === '100% Combed Cotton', '材质双语只留英文');
ok(f('柔软, 透气').trim() === '柔软, 透气', '纯中文原样返回（不误删）');
ok(f('').trim() === '', '空值返回空');
ok(f(null).trim() === '', 'null 不抛错');

// 切分后的项数：3 项，且不含 "/"
const items = f('Soft, Breathable, Skin-Friendly / 柔软, 透气, 亲肤').split(/[,，]/).map(s => s.trim()).filter(Boolean);
ok(items.length === 3 && !items.some(s => s.includes('/')), '按逗号切出 3 项且无 "/" 残留', JSON.stringify(items));

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail) console.log('失败项：' + bad.join(' / '));
process.exit(fail ? 1 : 0);
