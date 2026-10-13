// ============================================================
// 套图（快速五图）：任务生命周期 + 素材/提示词预检 测试
//
// 方式：
//  - 任务模块：直接加载 chrome_extension/suite/suite-task.js（生产源码）
//  - 页面预检：从 发品助手.html 按名抽取真实生产函数，在 Node vm 中运行
//  不复制任何业务分支。
// 运行：node tests/test-suite-task.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '发品助手.html'), 'utf8');
const SUITE_SRC = fs.readFileSync(path.join(ROOT, 'chrome_extension', 'suite', 'suite-task.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

/* ---------- 生产函数抽取（列 0 的 } 收尾） ---------- */
function extractFn(name) {
    const lines = HTML.split('\n');
    const re = new RegExp('^function\\s+' + name + '\\s*\\(');
    const are = new RegExp('^async\\s+function\\s+' + name + '\\s*\\(');
    let s = -1;
    for (let i = 0; i < lines.length; i++) { if (re.test(lines[i]) || are.test(lines[i])) { s = i; break; } }
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) { if (lines[j] === '}') return lines.slice(s, j + 1).join('\n'); }
    throw new Error('函数未闭合: ' + name);
}
function extractConst(name) {
    const m = new RegExp('^\\s*const\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(HTML);
    if (!m) throw new Error('未找到常量: ' + name);
    return m[0].trim();
}
function extractLet(name) {
    const m = new RegExp('^\\s*let\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(HTML);
    if (!m) throw new Error('未找到变量: ' + name);
    return m[0].trim();
}

/* ---------- 任务模块环境 ---------- */
function createTaskEnv(initial = {}) {
    const store = Object.assign({}, initial);
    const env = { chrome: { storage: { local: {
        get: (k, cb) => { const out = {}; const keys = Array.isArray(k) ? k : [k]; for (const kk of keys) if (kk in store) out[kk] = JSON.parse(JSON.stringify(store[kk])); cb(out); },
        set: (obj, cb) => { for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k])); if (cb) cb(); }
    } } } };
    env.globalThis = env;
    const ctx = vm.createContext(env);
    vm.runInContext(SUITE_SRC, ctx, { filename: 'suite-task.js' });
    return { ctx, store, run: (e) => vm.runInContext(e, ctx), S: env.SuiteTaskStore };
}

/* ---------- 页面预检环境 ---------- */
const PAGE_FNS = ['SuiteQuickFive', 'renderSuitePrompt', 'checkSuiteVariables', 'probeSuiteImage', 'resolveSuiteAssets', 'currentFileKey'];
function createPageEnv(opts = {}) {
    // SuiteQuickFive 是 const IIFE，单独抽取
    const iifeStart = HTML.indexOf('const SuiteQuickFive = (() => {');
    const iifeEnd = HTML.indexOf('})();', iifeStart);
    const iife = HTML.slice(iifeStart, iifeEnd + 5);
    const src = [extractConst('SUITE_OUTPUTS'), iife]
        .concat(['renderSuitePrompt', 'checkSuiteVariables', 'probeSuiteImage', 'resolveSuiteAssets', 'currentFileKey'].map(extractFn))
        .join('\n\n');

    const fetchLog = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        EXTENSION_ID: 'test-ext',
        loadedFileName: opts.loadedFileName === undefined ? 'A.xlsx' : opts.loadedFileName,
        products: [],
        extensionInstalled: opts.extensionInstalled !== false,
        getColorImagePath: (row, color) => (opts.colorPaths ? opts.colorPaths[row + ':' + color] : null),
        chrome: { runtime: { lastError: null, sendMessage: (id, req, cb) => { if (opts.onColorImage) opts.onColorImage(req, cb); else cb({ ok: false }); } } },
        // 只模拟外部 API（fetch / createImageBitmap），不模拟被测业务分支
        fetch: async (url) => {
            fetchLog.push(url);
            const spec = (opts.files || {})[url];
            if (!spec) return { ok: false, status: 404 };
            if (spec.empty) return { ok: true, status: 200, blob: async () => ({ size: 0, type: 'image/png' }) };
            if (spec.notImage) return { ok: true, status: 200, blob: async () => ({ size: 100, type: 'text/html' }) };
            return { ok: true, status: 200, blob: async () => ({ size: spec.size || 1024, type: spec.type || 'image/png' }) };
        },
        createImageBitmap: async (blob) => {
            if (opts.decodeFails) throw new Error('解码失败');
            const dim = opts.dim || { width: 800, height: 800 };
            return { width: dim.width, height: dim.height, close() {} };
        }
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext('var currentRowIndex = 0;', ctx);
    vm.runInContext(src, ctx, { filename: '发品助手.html:suite-fns' });
    return { ctx, fetchLog, run: (e) => vm.runInContext(e, ctx) };
}

// 五步配置（每步单图、编号唯一、模型/比例一致）
function mkSteps(over = {}) {
    return [['111', '卖点图'], ['222', '袖口图'], ['333', '面料图'], ['444', '白底图'], ['666', '领口图']]
        .map(([key, name]) => Object.assign({
            name, expectCount: 1, outputKeys: [{ key, postprocess: null }],
            prompt: `【${name}】基于当前套装参考图生成这一张图片。只生成一张图。`,
            model: '5.0', ratio: '1:1',
            uploads: [{ type: 'current_file', filenames: ['main.jpg'] }], mappings: []
        }, over[key] || {}));
}

(async function main() {
    console.log('=== 套图：任务生命周期 + 预检 测试 ===\n');

    // ================= A. 快速五图组装 =================
    console.log('【A】快速五图组装：一次请求 / 编号唯一 / 模型比例一致');
    {
        const env = createPageEnv();
        const steps = mkSteps();
        const task = await env.run(`SuiteQuickFive.build(${JSON.stringify(steps)}, async (s) => s.prompt)`);
        ok(task.expectCount === 5, 'expectCount = 5');
        ok(task.combinedFive === true, 'combinedFive = true（一次请求，非五次逐张）');
        ok(task.outputKeys.length === 5 && new Set(task.outputKeys.map(o => o.key)).size === 5, '5 个编号唯一');
        ok(task.outputKeys.map(o => o.key).join(',') === '111,222,333,444,666', `编号顺序正确（${task.outputKeys.map(o => o.key).join(',')}）`);
        ok(/五张图合并生成/.test(task.prompt), '提示词为合并结构');
        ok((task.prompt.match(/、步骤/g) || []).length === 5, '合并提示词包含 5 个步骤段');
        ok(!/只生成一张图/.test(task.prompt), '已移除"只生成一张图"类措辞');
        ok(/本段只描述这一张图片/.test(task.prompt), '措辞被替换为中性描述');

        // 编号缺失 / 重复
        let e1 = null;
        try { await env.run(`SuiteQuickFive.build(${JSON.stringify(mkSteps({ 222: { outputKeys: [{ key: '111' }] }}))}, async s => s.prompt)`); }
        catch (e) { e1 = e.message; }
        ok(e1 && /重复|缺少/.test(e1), `编号重复/缺失被拒绝（${e1}）`);

        // 模型/比例不一致
        let e2 = null;
        try { await env.run(`SuiteQuickFive.build(${JSON.stringify(mkSteps({ 333: { ratio: '4:3' }}))}, async s => s.prompt)`); }
        catch (e) { e2 = e.message; }
        ok(e2 && /模型与比例一致/.test(e2), `比例不一致被拒绝（${e2}）`);

        // 外部/随机素材 → 生成前拒绝并指明步骤
        let e3 = null;
        try { await env.run(`SuiteQuickFive.build(${JSON.stringify(mkSteps({ 444: { uploads: [{ type: 'external', filenames: ['x.png'] }] }}))}, async s => s.prompt)`); }
        catch (e) { e3 = e.message; }
        ok(e3 && /白底图/.test(e3) && /当前套装参考图/.test(e3), `外部素材被拒绝且指明步骤（${e3}）`);

        // 结果校验：5 张且互不相同
        const v = (arr) => { try { env.run(`SuiteQuickFive.validateImages(${JSON.stringify(arr)})`); return true; } catch (_) { return false; } };
        ok(v(['a', 'b', 'c', 'd', 'e']) === true, '5 张不同 → 通过');
        ok(v(['a', 'b', 'c', 'd']) === false, '少于 5 张 → 拒绝');
        ok(v(['a', 'a', 'b', 'c', 'd']) === false, '重复图片 → 拒绝');
        ok(v(['a', 'b', 'c', 'd', '']) === false, '空 URL → 拒绝');
    }

    // ================= B. 变量解析 =================
    console.log('\n【B】变量解析：未解析变量必须在发送前失败并指明步骤');
    {
        const env = createPageEnv();
        const product = { row: 412, material_en: 'Cotton' };
        const steps = mkSteps({ 333: { prompt: '面料 {{material_en}} / {{未定义字段}}' } });
        const problems = env.run(`checkSuiteVariables(${JSON.stringify(steps)}, ${JSON.stringify(product)})`);
        ok(Array.isArray(problems) && problems.some(p => /面料图/.test(p)) && problems.some(p => /未定义字段/.test(p)),
            `未解析变量被指出步骤与变量名（${JSON.stringify(problems)}）`);
        const steps2 = mkSteps({ 333: { prompt: '面料 {{material_en}}', mappings: [{ variable: 'material_en', field: 'material_en' }] } });
        const p2 = env.run(`checkSuiteVariables(${JSON.stringify(steps2)}, ${JSON.stringify(product)})`);
        ok(p2.length === 0, `声明映射后全部可解析（${JSON.stringify(p2)}）`);
        // 声明了但产品无该字段 → 渲染为空，不算未解析（值可为空）
        const steps3 = mkSteps({ 333: { prompt: '面料 {{missing_field}}', mappings: [{ variable: 'missing_field', field: 'missing_field' }] } });
        const p3b = env.run(`checkSuiteVariables(${JSON.stringify(steps3)}, ${JSON.stringify(product)})`);
        ok(p3b.length === 0, '已声明但取值为空的变量不报未解析（值允许为空）');
        const noStep = mkSteps().filter(s => s.outputKeys[0].key !== '666');
        const p3 = env.run(`checkSuiteVariables(${JSON.stringify(noStep)}, ${JSON.stringify(product)})`);
        ok(p3.some(p => /666/.test(p)), '缺少编号步骤被指出');
    }

    // ================= C. 素材真实性与完整性 =================
    console.log('\n【C】素材预检：有路径 ≠ 有图片');
    {
        const product = { row: 412 };
        // 全部有效
        const files = {
            'extracted_images/row412_main.jpg': { size: 2048 },
            'c_white': { size: 1000 }, 'c_black': { size: 1000 }, 'c_gray': { size: 1000 }, 'c_navy': { size: 1000 }
        };
        const envOk = createPageEnv({ files, colorPaths: { '412:white': 'c_white', '412:black': 'c_black', '412:gray': 'c_gray', '412:navy': 'c_navy' } });
        const r1 = await envOk.run(`resolveSuiteAssets(${JSON.stringify(product)})`);
        ok(r1.problems.length === 0, `全部有效 → 无问题（${JSON.stringify(r1.problems)}）`);
        ok(Object.keys(r1.assets).length === 5, `取到 5 项素材（${Object.keys(r1.assets).join(',')}）`);
        ok(r1.assets.white.bytes > 0 && r1.assets.white.width === 800, '记录真实字节数与解码尺寸');

        // 路径存在但文件为空
        const envEmpty = createPageEnv({ files: Object.assign({}, files, { 'c_navy': { empty: true } }), colorPaths: { '412:white': 'c_white', '412:black': 'c_black', '412:gray': 'c_gray', '412:navy': 'c_navy' } });
        const r2 = await envEmpty.run(`resolveSuiteAssets(${JSON.stringify(product)})`);
        ok(r2.problems.some(p => /navy/.test(p) && /为空/.test(p)), `空文件被识别（${JSON.stringify(r2.problems)}）`);

        // 缺失
        const envMiss = createPageEnv({ files: { 'extracted_images/row412_main.jpg': { size: 2048 } }, colorPaths: {} });
        const r3 = await envMiss.run(`resolveSuiteAssets(${JSON.stringify(product)})`);
        ok(r3.problems.length >= 4, `四色缺失全部报出（${r3.problems.length} 项）`);

        // 非位图 / 解码失败 / 尺寸过小
        const envBad = createPageEnv({ files: Object.assign({}, files, { 'c_gray': { notImage: true } }), colorPaths: { '412:white': 'c_white', '412:black': 'c_black', '412:gray': 'c_gray', '412:navy': 'c_navy' } });
        const r4 = await envBad.run(`resolveSuiteAssets(${JSON.stringify(product)})`);
        ok(r4.problems.some(p => /gray/.test(p) && /不是位图/.test(p)), '非位图被识别');

        const envDec = createPageEnv({ files, colorPaths: { '412:white': 'c_white', '412:black': 'c_black', '412:gray': 'c_gray', '412:navy': 'c_navy' }, decodeFails: true });
        const r5 = await envDec.run(`resolveSuiteAssets(${JSON.stringify(product)})`);
        ok(r5.problems.length === 5, `解码失败全部报出（${r5.problems.length} 项）`);

        const envTiny = createPageEnv({ files, colorPaths: { '412:white': 'c_white', '412:black': 'c_black', '412:gray': 'c_gray', '412:navy': 'c_navy' }, dim: { width: 32, height: 32 } });
        const r6 = await envTiny.run(`resolveSuiteAssets(${JSON.stringify(product)})`);
        ok(r6.problems.length === 5 && /尺寸无效/.test(r6.problems[0]), '尺寸过小被识别');
    }

    // ================= D. 任务生命周期 =================
    console.log('\n【D】套图任务：只创建一次 / 阶段机 / 身份核验');
    {
        const e = createTaskEnv();
        const base = { fileKey: 'A__', rowNum: 412, productId: 412, mode: 'quick-five', expectCount: 5, targetKeys: ['111', '222', '333', '444', '666'], prompt: 'x', assets: [] };
        const t1 = await e.S.create(base);
        ok(t1.stage === 'received', `创建后阶段为 received（${t1.stage}）`);
        ok(t1.taskId && t1.fileKey === 'A__' && t1.rowNum === 412, '包含 taskId/fileKey/rowNum');
        ok(Number.isInteger(t1.startedAt) && t1.startedAt > 0, '记录开始时间');

        // 防重复：同文件+行+模式再次创建被拒
        let dupErr = null;
        try { await e.S.create(base); } catch (err) { dupErr = err.message; }
        ok(dupErr && /拒绝重复发起/.test(dupErr), `重复创建被拒绝（${dupErr}）`);

        // expectCount 校验
        let ec = null;
        try { await e.S.create(Object.assign({}, base, { rowNum: 999, expectCount: 4 })); } catch (err) { ec = err.message; }
        ok(ec && /expectCount 必须为 5/.test(ec), `quick-five 的 expectCount 必须为 5（${ec}）`);

        // 阶段推进：不允许跳过 saved 直接 completed
        let skipErr = null;
        try { await e.S.advance(t1.taskId, 'completed'); } catch (err) { skipErr = err.message; }
        ok(skipErr && /未保存成功不允许标记完成/.test(skipErr), `未保存不允许完成（${skipErr}）`);

        await e.S.advance(t1.taskId, 'sent');
        await e.S.advance(t1.taskId, 'acquired');
        let back = null;
        try { await e.S.advance(t1.taskId, 'sent'); } catch (err) { back = err.message; }
        ok(back && /阶段不能回退/.test(back), `阶段不能回退（${back}）`);
        await e.S.advance(t1.taskId, 'saved', { results: [{ key: '111', saved: true }] });
        const done = await e.S.advance(t1.taskId, 'completed');
        ok(done.stage === 'completed', 'saved 之后可完成');

        // 身份核验：其他产品 / 已终态 / 阶段倒退
        const bad1 = await e.S.acceptReport({ taskId: t1.taskId, fileKey: 'A__', rowNum: 999, stage: 'sent' });
        ok(bad1.accepted === false && /身份不符/.test(bad1.reason), `其他行号回传被拒（${bad1.reason}）`);
        const bad2 = await e.S.acceptReport({ taskId: t1.taskId, fileKey: 'B__', rowNum: 412 });
        ok(bad2.accepted === false && /身份不符/.test(bad2.reason), '其他文件回传被拒');
        const bad3 = await e.S.acceptReport({ taskId: t1.taskId, fileKey: 'A__', rowNum: 412 });
        ok(bad3.accepted === false && /终态/.test(bad3.reason), `已终态任务拒绝迟到结果（${bad3.reason}）`);
        const bad4 = await e.S.acceptReport({ taskId: 'suite_nope', fileKey: 'A__', rowNum: 412 });
        ok(bad4.accepted === false && /未知任务/.test(bad4.reason), '未知任务被拒');
    }

    console.log('\n【E】取消后迟到回传不覆盖有效结果');
    {
        const e = createTaskEnv();
        const t = await e.S.create({ fileKey: 'A__', rowNum: 500, mode: 'quick-five', expectCount: 5, targetKeys: ['111', '222', '333', '444', '666'], prompt: 'x' });
        await e.S.advance(t.taskId, 'sent');
        await e.S.cancel(t.taskId, '用户停止');
        const r = await e.S.acceptReport({ taskId: t.taskId, fileKey: 'A__', rowNum: 500, stage: 'acquired', results: [{ key: '111', saved: true }] });
        ok(r.accepted === false && /已取消/.test(r.reason), `取消后迟到回传被拒（${r.reason}）`);
        const cur = await e.S.get(t.taskId);
        ok((cur.results || []).length === 0, '有效结果未被覆盖');
        ok(cur.stage === 'interrupted', '终态为 interrupted');
    }

    console.log('\n【F】文件/行号隔离 与 冷启动恢复');
    {
        const e = createTaskEnv();
        await e.S.create({ fileKey: 'A__', rowNum: 412, mode: 'quick-five', expectCount: 5, targetKeys: ['111', '222', '333', '444', '666'], prompt: 'x' });
        await e.S.create({ fileKey: 'B__', rowNum: 412, mode: 'quick-five', expectCount: 5, targetKeys: ['111', '222', '333', '444', '666'], prompt: 'x' });
        const a = await e.S.list({ fileKey: 'A__', rowNum: 412 });
        const b = await e.S.list({ fileKey: 'B__', rowNum: 412 });
        ok(a.length === 1 && b.length === 1 && a[0].taskId !== b[0].taskId, '同文件标识不同 → 任务隔离');
        const sameRowOtherFile = await e.S.list({ fileKey: 'A__', rowNum: 412 });
        ok(sameRowOtherFile.every(t => t.fileKey === 'A__'), '按文件标识过滤只返回本文件');

        // 冷启动：非终态 → interrupted，且不自动重发
        const before = await e.S.list({ activeOnly: true });
        ok(before.length === 2, `恢复前有 2 个非终态任务（${before.length}）`);
        const interrupted = await e.S.recoverOnStartup();
        ok(interrupted.length === 2, `冷启动标记 2 个任务为中断（${interrupted.length}）`);
        const after = await e.S.list({ activeOnly: true });
        ok(after.length === 0, '恢复后无"运行中"任务（不谎报仍在跑）');
        const t0 = await e.S.get(interrupted[0]);
        ok(t0.stage === 'interrupted' && /执行上下文丢失/.test(t0.error), `中断原因明确（${t0.error}）`);
        const late = await e.S.acceptReport({ taskId: interrupted[0], fileKey: t0.fileKey, rowNum: t0.rowNum, stage: 'acquired' });
        ok(late.accepted === false, '恢复后拒绝自动续跑/迟到回传');
    }

    console.log('\n' + '='.repeat(52));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(52));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
