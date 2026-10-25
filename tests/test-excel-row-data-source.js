// 验收：后处理脚本数据源从「属性TXT文件夹」改为「当前导入Excel的当前产品行」。
// 覆盖：五类目字段对应 / 行快照隔离与锁定 / 实际行号 / 0 与空值区分 / 类目归一化 /
//       TXT 入口残留 / 卡片图片资源仍传递 / 图像处理逻辑未被改动。
// 只模拟浏览器外部依赖，不发起真实生图，不读属性 TXT 文件夹。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// ---------- 1. 加载被改造的模块（真实业务模块，非替身） ----------
const ctx = { window: {}, console: { log() {}, warn() {}, error() {} } };
vm.createContext(ctx);
for (const f of ['category-field-rules.js', 'excel-row.js', 'custom-js-data.js', 'script-contract-parser.js']) {
    vm.runInContext(read(f), ctx, { filename: f });
}
const Rules = ctx.window.CategoryFieldRules, ExcelRow = ctx.window.ExcelRow, Domain = ctx.window.CustomJsDataDomain;
assert(Rules && ExcelRow && Domain, '模块未挂载到 window');

// 从发品助手.html 抽取行快照构建入口（真实业务实现，不重写）
const html = read('发品助手.html');
const slice = html.slice(html.indexOf('function sheetRangeStartRow('), html.indexOf('// 读取 Excel 文件'));
vm.runInContext('let currentSheet = null;\n' + slice, ctx, { filename: '发品助手.html:sheet' });

// 从 js代码 读取四个读属性的脚本源码
const scripts = {
    111: read('chrome_extension/js代码/111卖点图后处理.js'),
    222: read('chrome_extension/js代码/222细节图后处理.js'),
    333: read('chrome_extension/js代码/333面料图后处理.js'),
    666: read('chrome_extension/js代码/666领口图后处理.js'),
};
const pure = {
    '111扩图': read('chrome_extension/js代码/111扩图.js'),
    '444扩图': read('chrome_extension/js代码/444扩图.js'),
    '444叠加': read('chrome_extension/js代码/444叠加后处理.js'),
};

// 用真实表头构造某类目的行快照
function snap(category, overrides, rowNumber) {
    const headers = Array.from(Rules.columnsOf(category));
    const values = headers.map(h => (overrides && h in overrides) ? overrides[h] : '');
    const idx = headers.indexOf('类目');
    if (idx >= 0 && !(overrides && '类目' in overrides)) values[idx] = category;
    return ExcelRow.build({ fileName: '业务表.xlsx', sheetName: 'Sheet1', rowNumber: rowNumber || 2, headers, values });
}

// ---------- 2. 五类目分别读取正确字段（真实列名，随类目变化） ----------
const expectSleeve = { polo: '袖子款式', shirt: '袖长(cm)', 't-shirt': '袖子款式', 'hooded-sweatshirt': '袖型', 'non-hooded-sweatshirt': '袖型' };
const expectWeave = { polo: '编织方法', shirt: '编织方法', 't-shirt': '编织方法', 'hooded-sweatshirt': '编织方式', 'non-hooded-sweatshirt': '编织方式' };
const expectStyle = { polo: '样式', shirt: '样式', 't-shirt': '样式', 'hooded-sweatshirt': '款式', 'non-hooded-sweatshirt': '款式' };
const expectPrint = { polo: '印花方法', shirt: '印花方法', 't-shirt': '印花方法', 'hooded-sweatshirt': '印花方式', 'non-hooded-sweatshirt': '印花方式' };
const expectCollar = { polo: null, shirt: '领型', 't-shirt': '领子', 'hooded-sweatshirt': '领型', 'non-hooded-sweatshirt': '领型' };
for (const cat of Object.keys(expectSleeve)) {
    const t = snap(cat, { 材质: 'Cotton', 工艺: 'Printed', 面料克重: 280, 产品特性: 'Breathable' });
    assert.equal(t.category(), cat, cat + ' 归一化错误');
    assert.equal(t.role('sleeve').column, expectSleeve[cat], cat + ' 袖列错误');
    assert.equal(t.role('weave').column, expectWeave[cat], cat + ' 编织列错误');
    assert.equal(t.role('style').column, expectStyle[cat], cat + ' 样式列错误');
    assert.equal(t.role('print').column, expectPrint[cat], cat + ' 印花列错误');
    assert.equal(t.optionalRole('collar').column, expectCollar[cat], cat + ' 领列错误');
    assert.equal(t.cell('材质'), 'Cotton', cat + ' 材质取值错误');
    assert.equal(t.role('feature').column, '产品特性', cat + ' 特性列错误');
    assert.equal(t.role('weight').column, '面料克重', cat + ' 克重列错误');
    // polo 无领列：optionalRole 返回空，不抛错
    if (cat === 'polo') {
        const collar = t.optionalRole('collar');
        assert.equal(collar.role, 'collar');
        assert.equal(collar.column, null);
        assert.equal(collar.value, '');
    }
}
// 衬衫袖长列名必须是「袖长(cm)」，不是「袖长」
assert.equal(Rules.columnOf('sleeve', 'shirt'), '袖长(cm)');
assert(!Rules.columnsOf('shirt').includes('袖长'), '衬衫不应存在「袖长」列');
// t-shirt 用「面料克重」「产品特性」，不是旧的「克重」「特性」
assert(Rules.columnsOf('t-shirt').includes('面料克重') && Rules.columnsOf('t-shirt').includes('产品特性'));
assert(!Rules.columnsOf('t-shirt').includes('克重') && !Rules.columnsOf('t-shirt').includes('特性'), 't-shirt 不应回退旧列名');
// 帽衫/无帽卫衣用「编织方式」，不是「编织方法」
assert(!Rules.columnsOf('hooded-sweatshirt').includes('编织方法'));
assert(!Rules.columnsOf('non-hooded-sweatshirt').includes('编织方法'));
// 五类目列数与示例表一致
assert.equal(Rules.columnsOf('polo').length, 22);
assert.equal(Rules.columnsOf('shirt').length, 24);
assert.equal(Rules.columnsOf('t-shirt').length, 24);
assert.equal(Rules.columnsOf('hooded-sweatshirt').length, 25);
assert.equal(Rules.columnsOf('non-hooded-sweatshirt').length, 25);

// ---------- 3. 同一 Excel 两行产品数据不同，不串行 ----------
const twoRowHeaders = Array.from(Rules.columnsOf('polo'));
const mkRow = (title, material, weight, rowNumber) => ExcelRow.build({
    fileName: 'two.xlsx', sheetName: 'S', rowNumber, headers: twoRowHeaders,
    values: twoRowHeaders.map(h => ({ 标题: title, 材质: material, 面料克重: weight, 类目: 'polo(2)' }[h] ?? '')),
});
const rowA = mkRow('Row A title', 'Cotton', 180, 4);
const rowB = mkRow('Row B title', 'Polyester', 320, 9);
assert.equal(rowA.cell('标题'), 'Row A title');
assert.equal(rowB.cell('标题'), 'Row B title');
assert.equal(rowA.cell('面料克重'), '180');
assert.equal(rowB.cell('面料克重'), '320');
assert.notEqual(rowA.rowNumber, rowB.rowNumber);

// ---------- 4. 任务开始后切换产品/重导 Excel，旧任务仍用原快照 ----------
const sourceValues = twoRowHeaders.map(h => ({ 标题: 'Original', 材质: 'Silk', 类目: 'polo(2)' }[h] ?? ''));
const locked = ExcelRow.build({ fileName: 'a.xlsx', sheetName: 'S1', rowNumber: 7, headers: twoRowHeaders, values: sourceValues });
sourceValues[twoRowHeaders.indexOf('标题')] = 'MUTATED';      // 改源数组
sourceValues[twoRowHeaders.indexOf('材质')] = 'MUTATED';
assert.equal(locked.cell('标题'), 'Original', '快照被源数组后续修改影响');
assert.equal(locked.cell('材质'), 'Silk', '快照被源数组后续修改影响');
assert(Object.isFrozen(locked) && Object.isFrozen(locked.headers), '快照应冻结');
assert.equal(locked.fileName, 'a.xlsx');
assert.equal(locked.rowNumber, 7);
assert.equal(locked.describe(), '文件「a.xlsx」工作表「S1」第 7 行');

// ---------- 5. 表头不在第 1 行、数据中有空行时实际行号仍正确 ----------
assert.equal(vm.runInContext('sheetRangeStartRow("A3:F100")', ctx), 3, '表头在第 3 行时起始行号应为 3');
assert.equal(vm.runInContext('sheetRangeStartRow("$B$1:$Z$9")', ctx), 1);
ctx.__sheet = {
    fileName: 'offset.xlsx', sheetName: '数据', startRow: 3,
    headers: ['类目', '材质', '面料克重'],
    rows: [['类目', '材质', '面料克重'], ['polo(2)', '棉', 180], [], ['t-shirt(1)', '涤纶', 0]],
};
vm.runInContext('currentSheet = __sheet;', ctx);
const r6 = vm.runInContext('buildExcelRowSnapshot(6)', ctx);
assert.equal(r6.rowNumber, 6, '实际 Excel 行号应为 6（表头在第 3 行 + 数据下标 3）');
assert.equal(r6.category(), 't-shirt');
assert.equal(r6.cell('面料克重'), '0', '数字 0 必须保留为 "0"');
const r5 = vm.runInContext('buildExcelRowSnapshot(5)', ctx);   // 空行
assert.equal(r5.rowNumber, 5);
assert.equal(r5.cell('类目'), '', '空行取值应为空串');
assert.throws(() => r5.category(), /类目为空/, '空行无法归一化类目时应报错');
// 不存在的行号明确报错，且带工作表名
assert.throws(() => vm.runInContext('buildExcelRowSnapshot(99)', ctx), /数据.*第 99 行/);

// ---------- 6. 数字克重 / 0 / 空单元格 / 整列不存在的区别 ----------
const h6 = ['类目', '面料克重', '产品特性'];
const t6 = ExcelRow.build({ fileName: 'f.xlsx', sheetName: 'S', rowNumber: 2, headers: h6, values: ['polo(2)', 280, ''] });
assert.equal(t6.cell('面料克重'), '280', '数字克重应转字符串');
assert.equal(t6.raw('面料克重'), 280, 'raw 应保留原始数字');
assert.equal(t6.cell('产品特性'), '', '本行该格为空应返回空串');
assert.equal(t6.raw('产品特性'), '', 'raw 空单元格返回原值');
const t0 = ExcelRow.build({ fileName: 'f.xlsx', sheetName: 'S', rowNumber: 3, headers: h6, values: ['polo(2)', 0, null] });
assert.equal(t0.cell('面料克重'), '0', '数值 0 不能被 || \'\' 吞掉');
assert.equal(t0.cell('产品特性'), '', 'null 应为空串');
// 整列不存在：抛错，且报错带 文件 / 工作表 / 行号 / 列名
assert.throws(() => t6.cell('克重'), /文件「f\.xlsx」工作表「S」第 2 行：整列不存在「克重」/);
assert.equal(t6.has('克重'), false, 'has 应区分整列不存在');
assert.equal(t6.has('产品特性'), true);
// 缺失必要字段时报错同样带上下文
assert.throws(() => t6.role('sleeve'), /第 2 行/);

// ---------- 7. 五种带编号类目值的归一化 ----------
const norm = [['polo(2)', 'polo'], ['shirt(3)', 'shirt'], ['T-shirt(1)', 't-shirt'],
    ['Hooded sweatshirt(4)', 'hooded-sweatshirt'], ['Non-hooded sweatshirt(5)', 'non-hooded-sweatshirt']];
for (const [raw, want] of norm) assert.equal(Rules.normalizeCategory(raw), want, raw + ' 归一化错误');
// 大小写 / 首尾空格 / 空格与连字符
assert.equal(Rules.normalizeCategory('  Polo (2)  '), 'polo');
assert.equal(Rules.normalizeCategory('T Shirt(1)'), 't-shirt');
assert.equal(Rules.normalizeCategory('T-SHIRT'), 't-shirt');
assert.equal(Rules.normalizeCategory('Hooded_Sweatshirt (4)'), 'hooded-sweatshirt');
assert.equal(Rules.normalizeCategory('non hooded sweatshirt(5)'), 'non-hooded-sweatshirt');
// 无帽卫衣不能误判为帽衫
assert.notEqual(Rules.normalizeCategory('Non-hooded sweatshirt(5)'), 'hooded-sweatshirt');
// 未知类目明确报错，不能默认为 Polo
assert.throws(() => Rules.normalizeCategory('Jacket(9)'), /未知类目/);
assert.throws(() => Rules.normalizeCategory(''), /类目为空/);
assert.throws(() => Rules.normalizeCategory('   '), /类目为空/);

// ---------- 8. 属性读取不再调用 TXT 文件夹资源 ----------
for (const [name, src] of Object.entries(scripts)) {
    assert(!/loadResource\(\s*['"]dataFolder['"]/.test(src), name + ' 仍在读取属性文件夹');
    assert(!/\.txt['"]/.test(src), name + ' 仍引用 *.txt');
    assert(!/\b(folder|task)\s*\[\s*['"][^'"]*\.txt['"]/.test(src), name + ' 仍按 *.txt 键取值');
    assert(!/\bdataFolder\b/.test(src), name + ' 仍存在 dataFolder 引用');
    // 声明与运行接口同步：必须声明 row 类型资源，且 @needs row:product
    assert(/@needs\s+row:product/.test(src), name + ' 缺少 @needs row:product');
    assert(/@resource\s+\w+\s+row\s+"[^"]*"\s+from:currentSet\.row/.test(src), name + ' 缺少 row 资源声明');
    // 实际读取走 ctx.data（真实列名 / 角色），不再走 TXT 字典
    assert(/ctx\.data\.(cell|role|optionalRole)\(/.test(src), name + ' 未改用 ctx.data 读取');
    // 纯图像处理脚本不应被强行加 Excel 依赖
    assert(!/ctx\.data\.excelRow/.test(src) || /@needs\s+row:product/.test(src), name + ' 行依赖与声明不一致');
}
// 纯图像脚本确实不读取属性
for (const [name, src] of Object.entries(pure)) {
    if (name === '444叠加') continue;   // 图片资源接口，不读取 Excel 属性
    assert(!/ctx\.data|@needs\s+row:/.test(src), name + ' 是纯图像脚本，不应新增 Excel 行依赖');
}

// ---------- 9. 资源声明解析器识别 row 类型 ----------
const decl = ctx.window.parseResourceDeclarations(scripts[111]);
const productRow = decl.find(d => d.key === 'productRow');
assert(productRow, '未解析出 productRow 声明');
assert.equal(productRow.type, 'row');
assert.equal(productRow.source, 'currentSet.row');
assert.equal(decl.filter(d => d.type === 'row').length, 1);

// ---------- 10. 卡片图片等图像资源仍正常传递 ----------
const cardUrl = 'data:image/png;base64,AAAA';
const domain = Domain.create({ excelRow: snap('polo', {}), resources: { cardImage: cardUrl } });
(async () => {
    assert.equal(await domain.hasResource('cardImage'), true);
    assert.equal(await domain.loadResource('cardImage'), cardUrl, '卡片图片 dataUrl 未被改变用途');
    assert.equal(await domain.hasResource('材质.txt'), false, '不应存在虚拟 TXT 键');
    // 叠加脚本只读取图片；缺图明确失败，不画属性卡替代。
    assert(/ctx\.data\.loadResource\(['"]cardImage['"]\)/.test(pure['444叠加']));
    assert(!/@optional\s+cardImage/.test(pure['444叠加']));
    assert(!/ctx\.data\.(cell|role|optionalRole|excelRow)/.test(pure['444叠加']));
    const draws=[]; let execution;
    const cardContext={CustomJsSDK:{run(fn){execution=fn;}},Image:class {
        set src(value){assert.equal(value,cardUrl);this.onload();}
    }};
    vm.runInNewContext(pure['444叠加'],cardContext);
    const surface={canvas:{width:1024,height:1024},ctx:{
        measureText(text){return {width:text.length*8};},
        fillText(text){draws.push(text);},drawImage(){draws.push('custom-card');}
    },log(){}};
    await assert.rejects(()=>execution({...surface,data:Domain.create({resources:{}})}),/缺少 cardImage/);
    assert.deepEqual(draws,[],'缺图时不能绘制任何替代内容');
    await execution({...surface,data:Domain.create({resources:{cardImage:cardUrl}})});
    assert.deepEqual(draws,['custom-card'],'选择卡片后应保留原图片叠加路径');
    assert(/@resource\s+cardImage\s+file\s+"[^"]*"\s+from:user/.test(pure['444叠加']));
    // 行数据缺失时明确报错（不静默返回空）
    const empty = Domain.create({ excelRow: null });
    assert.throws(() => empty.cell('材质'), /未绑定 Excel 行数据/);
})().then(() => {
    // ---------- 11. 图像处理逻辑未被数据源调整改动 ----------
    assert(/async function annotateImageOnCanvas/.test(scripts[111]), '111 绘制管线缺失');
    assert(/rembgRemoveBackground/.test(scripts[111]), '111 抠图逻辑缺失');
    for (const k of ['222', '333', '666']) {
        assert(/drawTextWithStroke/.test(scripts[k]), k + ' 文字绘制逻辑缺失');
        assert(/rgbToHsv/.test(scripts[k]), k + ' 颜色分析逻辑缺失');
        assert(/g\.getImageData/.test(scripts[k]), k + ' 像素读取逻辑缺失');
    }
    assert(/g\.drawImage\(cardImg/.test(pure['444叠加']), '444叠加 叠加逻辑缺失');
    assert(/rembgRemoveBackground|gridAnalysis/.test(pure['111扩图']), '111扩图 抠图逻辑缺失');
    assert(/expand|drawImage/.test(pure['444扩图']), '444扩图 扩图逻辑缺失');
    // 222 仍按类目分支取袖列（shirt 才拼袖长）
    assert(/groupVal === 'shirt'/.test(scripts[222]) && /ctx\.data\.role\('sleeve'\)/.test(scripts[222]));
    // 666 按类目分支取领/门襟/编织/设计
    assert(/optionalRole\('collar'\)/.test(scripts[666]) && /optionalRole\('placket'\)/.test(scripts[666]) && /role\('weave'\)/.test(scripts[666]));
    // 111 按类目分支选卖点来源
    assert(/groupVal === 'polo'/.test(scripts[111]) && /groupVal === 't-shirt'/.test(scripts[111]));

    // ---------- 12. 五份单类目示例表表头与字段规则一致（示例表不是执行数据源） ----------
    vm.runInContext(read('xlsx.full.min.js'), ctx, { filename: 'xlsx.full.min.js' });
    const XLSX = ctx.XLSX;
    assert(XLSX, 'xlsx 库未挂载');
    for (const cat of ['polo', 'shirt', 't-shirt', 'hooded-sweatshirt', 'non-hooded-sweatshirt']) {
        const buf = fs.readFileSync(path.join(root, 'chrome_extension/映射示例/映射示例_' + cat + '.xlsx'));
        const wb = XLSX.read(buf, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const header = (rows[0] || []).map(v => String(v));
        assert.equal(header.join('|'), Array.from(Rules.columnsOf(cat)).join('|'), cat + ' 示例表表头与字段规则不一致');
    }
    console.log('PASS Excel 行数据源：五类目字段对应 / 行快照隔离锁定 / 实际行号 / 0与空值区分 / 类目归一化 / TXT入口已移除 / 卡片图片仍为图片资源 / 图像逻辑未变');
}).catch(e => { console.error('FAIL', e); process.exit(1); });
