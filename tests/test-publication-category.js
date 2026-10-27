/**
 * 类目 → 公共图清单：有帽卫衣被当成无帽卫衣传错 4 张图的回归测试。
 * 真机数据：product.category = "Hooded sweatshirt(4)"，product._categoryType = "sweatshirt"。
 * 旧实现优先用 _categoryType，值等于 "sweatshirt" 就判成 non-hooded-sweatshirt。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'chrome_extension/upload/publication-images.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0; const bad = [];
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, bad.push(m), console.log('  ❌ ' + m + (extra ? ' :: ' + extra : ''))); };

const sb = { console, Object, String, Error, RegExp, Array };
vm.createContext(sb);
vm.runInContext(SRC, sb, { filename: 'publication-images.js' });
const { category, plan } = sb.PublicationImages;

console.log('=== 类目 → 公共图 ===');

// 1) 真机那一行：帽型在 category 里，_categoryType 只有 sweatshirt
{
    const p = { category: 'Hooded sweatshirt(4)', _categoryType: 'sweatshirt' };
    ok(category(p) === 'hooded-sweatshirt', '有帽卫衣（真机取值）判成 hooded-sweatshirt', category(p));
    const main = plan(p, 'main');
    ok(main.category === 'hooded-sweatshirt' && main.bank.join(',') === '1,2-2,3,4',
        '主图取有帽卫衣的 4 张公共图', JSON.stringify(main));
    ok(main.keys.join(',') === '444,111', '主图仍取 444 + 111');
}
// 2) 无帽卫衣不能被误判成有帽
{
    const p = { category: 'Non-hooded sweatshirt(2)', _categoryType: 'sweatshirt' };
    ok(category(p) === 'non-hooded-sweatshirt', '无帽卫衣判成 non-hooded-sweatshirt', category(p));
    ok(plan(p, 'main').bank.join(',') === '1,2-1,3,4', '无帽卫衣用 2-1 那套图');
}
// 3) 只剩粗类型 → 报错，不许猜
{
    let threw = '';
    try { category({ _categoryType: 'sweatshirt' }); } catch (e) { threw = e.message; }
    ok(/帽型信息/.test(threw), '只有 sweatshirt 时明确报错（不猜帽型）', threw);
}
// 4) 其他类目不受影响
{
    ok(category({ category: 'Polo(2)' }) === 'polo', 'Polo');
    ok(category({ category: 'T-shirt(3)' }) === 't-shirt', 'T恤');
    ok(category({ category: 'Shirt(1)' }) === 'shirt', '衬衫');
    ok(category({ category: '连帽卫衣(2)' }) === 'hooded-sweatshirt', '中文「连帽卫衣」');
    ok(category({ category: '无帽卫衣' }) === 'non-hooded-sweatshirt', '中文「无帽卫衣」');
}
// 5) 细节图仍固定 333/666/222，且不带公共图
{
    const d = plan({ category: 'Hooded sweatshirt(4)' }, 'detail');
    ok(d.keys.join(',') === '333,666,222' && d.bank.length === 0, '细节图 333/666/222 无公共图', JSON.stringify(d));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail) console.log('失败项：' + bad.join(' / '));
process.exit(fail ? 1 : 0);
