// ============================================================
// 套图后处理执行器测试（生产源码 chrome_extension/suite/suite-postprocess.js）
// 覆盖：配置校验 / 资源声明解析 / 未配置直通 / 不支持类型拒绝 /
//       资源缺失明确失败 / 脚本失败不静默跳过 / continueOnError / 只重试处理
// 运行：node tests/test-suite-postprocess.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'suite', 'suite-postprocess.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(c, n, e) { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' :: ' + e : ''}`); } }

const env = { console: { log() {}, warn() {}, error() {} } };
env.globalThis = env;
env.window = env;   // custom-step-defaults.js 挂到 window.*，与页面一致
const ctx = vm.createContext(env);
vm.runInContext(SRC, ctx, { filename: 'suite-postprocess.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'custom-step-defaults.js'), 'utf8'), ctx, { filename: 'custom-step-defaults.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'suite', 'suite-image-sdk.js'), 'utf8'), ctx, { filename: 'suite-image-sdk.js' });
const PP = env.SuitePostprocess;
const SDK = env.SuiteImageSdk;

const K = ['111', '222', '333', '444', '666'];
const stepFor = (key, postprocess) => ({
    outputKeys: [{ key }], postprocess,
    prompt: 'x', model: '5.0', ratio: '1:1'
});
const blobOf = (n) => ({ size: n, arrayBuffer: async () => new ArrayBuffer(n), _mark: n });

(async function main() {
    console.log('=== 套图后处理执行器 测试 ===\n');

    console.log('【1】@resource 声明解析');
    {
        const src = `// @resource logoImg type=file name=logo.png
// @resource icons type=folder
function process(input, r){ return input; }`;
        const d = PP.parseResourceDeclarations(src);
        ok(d.length === 2, `解析出 2 条声明（${d.length}）`);
        ok(d[0].key === 'logoImg' && d[0].type === 'file' && d[0].name === 'logo.png', 'file 声明字段正确');
        ok(d[1].key === 'icons' && d[1].type === 'folder', 'folder 声明字段正确');
        ok(PP.parseResourceDeclarations('').length === 0, '无声明时返回空');
    }

    console.log('\n【2】生成前可用性预检（精确到编号）');
    {
        const steps = K.map(k => stepFor(k, { type: 'none' }));
        ok(PP.checkAvailability(steps, K).ok === true, '全部 none → 可用');

        const bad = K.map(k => stepFor(k, { type: 'none' }));
        bad[2].postprocess = { type: 'magicWand' };
        const r1 = PP.checkAvailability(bad, K);
        ok(r1.ok === false && r1.problems.some(p => /333/.test(p) && /不支持/.test(p)), `不支持类型被指出编号（${JSON.stringify(r1.problems)}）`);

        const noScript = K.map(k => stepFor(k, { type: 'none' }));
        noScript[1].postprocess = { type: 'customJs', script: '  ' };
        const r2 = PP.checkAvailability(noScript, K);
        ok(r2.ok === false && r2.problems.some(p => /222/.test(p) && /脚本为空/.test(p)), '空脚本被指出');

        const needRes = K.map(k => stepFor(k, { type: 'none' }));
        needRes[4].postprocess = { type: 'customJs', script: '// @resource logo type=file name=logo.png\nfunction process(i){return i;}' };
        const r3 = PP.checkAvailability(needRes, K, () => false);
        ok(r3.ok === false && r3.problems.some(p => /666/.test(p) && /logo/.test(p)), `缺资源在生成前被指出（${JSON.stringify(r3.problems)}）`);
        const r4 = PP.checkAvailability(needRes, K, () => true);
        ok(r4.ok === true, '资源齐备 → 预检通过');

        const missingStep = K.slice(0, 4).map(k => stepFor(k, { type: 'none' }));
        const r5 = PP.checkAvailability(missingStep, K);
        ok(r5.ok === false && r5.problems.some(p => /666/.test(p)), '缺步骤被指出');
    }

    console.log('\n【3】执行：未配置直通 / 不支持明确失败');
    {
        const input = blobOf(100);
        const r1 = await PP.runStep(stepFor('111', undefined), '111', input);
        ok(r1.ok && r1.applied === 'none' && r1.output === input, '未配置后处理 → 原图直通且状态如实标 none');
        const r2 = await PP.runStep(stepFor('111', { type: 'none' }), '111', input);
        ok(r2.ok && r2.output === input, 'type=none → 原图直通');
        const r3 = await PP.runStep(stepFor('111', { type: 'unknown' }), '111', input);
        ok(r3.ok === false && /不支持/.test(r3.error) && r3.key === '111', `不支持类型 → 明确失败并带编号（${r3.error}）`);
    }

    console.log('\n【4】资源缺失 / 脚本失败 → 明确失败，不静默跳过');
    {
        const input = blobOf(100);
        const withRes = stepFor('222', { type: 'customJs', script: '// @resource logo type=file name=logo.png\nfunction process(i){return i;}' });
        const r1 = await PP.runStep(withRes, '222', input, { getHandle: async () => null });
        ok(r1.ok === false && /资源未授权或缺失/.test(r1.error) && r1.key === '222', `资源缺失 → 失败（${r1.error}）`);

        const r2 = await PP.runStep(stepFor('333', { type: 'customJs', script: 'function process(){ throw new Error("坏脚本"); }' }), '333', input, { getHandle: async () => null });
        ok(r2.ok === false && /坏脚本/.test(r2.error), `脚本抛错 → 失败（${r2.error}）`);

        const r3 = await PP.runStep(stepFor('444', { type: 'customJs', script: 'function process(){ return null; }' }), '444', input, { getHandle: async () => null });
        ok(r3.ok === false && /未返回有效图片/.test(r3.error), '脚本不返回有效 Blob → 失败');

        const r4 = await PP.runStep(stepFor('666', { type: 'customJs', script: 'function process(i){ return { size: 5, arrayBuffer(){} }; }' }), '666', input, { getHandle: async () => null });
        ok(r4.ok === true && r4.output.size === 5, '脚本返回有效 Blob → 成功');
    }

    console.log('\n【5】编排：任一失败即整体失败；continueOnError 可继续；只重试处理');
    {
        const blobs = {}; for (const k of K) blobs[k] = blobOf(100);
        const good = K.map(k => stepFor(k, { type: 'customJs', script: 'function process(i){ return { size: i.size, arrayBuffer(){} }; }' }));
        const r1 = await PP.runAll(good, K, blobs, { getHandle: async () => null });
        ok(r1.ok === true && r1.results.length === 5, '五步全成功 → ok');
        ok(r1.retryProcessOnly === false, '无失败时不提示只重试');

        const bad = K.map(k => stepFor(k, { type: 'customJs', script: 'function process(i){ return { size: i.size, arrayBuffer(){} }; }' }));
        bad[2].postprocess = { type: 'customJs', script: 'function process(){ throw new Error("333失败"); }' };
        const r2 = await PP.runAll(bad, K, blobs, { getHandle: async () => null });
        ok(r2.ok === false && r2.failedKeys.join(',') === '333', `失败编号被指出（${r2.failedKeys.join(',')}）`);
        ok(r2.retryProcessOnly === true, '标记可"只重试处理"（不重新生图）');
        ok(r2.results.length === 3, `默认遇错即停（已处理 ${r2.results.length} 项）`);

        const cont = K.map(k => stepFor(k, { type: 'customJs', script: 'function process(i){ return { size: i.size, arrayBuffer(){} }; }' }));
        cont[2].postprocess = { type: 'customJs', script: 'function process(){ throw new Error("333失败"); }', continueOnError: true };
        const r3 = await PP.runAll(cont, K, blobs, { getHandle: async () => null });
        ok(r3.results.length === 5, `continueOnError → 继续处理其余（${r3.results.length} 项）`);
        ok(r3.ok === false && r3.failedKeys.join(',') === '333', '仍如实报告失败编号（不因继续而假装成功）');

        const miss = Object.assign({}, blobs); delete miss['444'];
        const r4 = await PP.runAll(good, K, miss, { getHandle: async () => null });
        ok(r4.ok === false && r4.failedKeys.indexOf('444') >= 0, '缺原图 → 该编号失败');
    }

    console.log('\n【6】「无后处理」与「已配置但脚本为空」必须区分开（不得静默跳过）');
    {
        const input = blobOf(100);

        // —— 无后处理：允许执行 ——
        ok(PP.operationsOf(undefined).length === 0, 'postprocess 缺省 → 无后处理条目');
        ok(PP.operationsOf([]).length === 0, '空数组 → 无后处理条目');
        ok(PP.operationsOf([{ type: 'none' }]).length === 1, 'type=none 保留为显式无操作');
        ok(PP.operationsOf([{}]).length === 0, '空壳条目（无 type、无脚本名）→ 视为未配置');
        const noneStep = { key: '111', name: '卖点图', postprocess: [] };
        const rNone = await PP.runStep(noneStep, '111', input);
        ok(rNone.ok === true && rNone.applied === 'none' && rNone.output === input, '无后处理 → 允许执行且原图直通');
        ok(PP.checkAvailability([noneStep], ['111']).ok === true, '无后处理 → 预检通过');

        // —— 已配置但脚本为空（面板条目 { name, path, code:'' }）——
        const placeholder = { key: '222', name: '细节图', postprocess: [{ name: '222细节图后处理.js', path: 'js代码/222细节图后处理.js', code: '' }] };
        const ops = PP.operationsOf(placeholder.postprocess);
        ok(ops.length === 1 && ops[0].type === 'customJs' && ops[0].script === '', '占位脚本被识别为「已配置的自定义脚本」，没有被丢弃');
        const rCheck = PP.checkAvailability([placeholder], ['222']);
        ok(rCheck.ok === false, '预检必须不通过（不得静默当成无后处理）');
        ok(rCheck.problems.some(p => p.includes('222') && p.includes('细节图') && p.includes('222细节图后处理.js')), `报错同时指出输出编号、步骤名与脚本名（${JSON.stringify(rCheck.problems)}）`);
        const rRun = await PP.runStep(placeholder, '222', input, { getHandle: async () => null });
        ok(rRun.ok === false && rRun.key === '222' && rRun.error.includes('222细节图后处理.js'), `执行也必须明确失败并带脚本名（${rRun.error}）`);
        ok(rRun.error.includes('细节图'), `执行失败报错同时带步骤显示名（${rRun.error}）`);
        ok(rRun.output === undefined, '失败时不得把原图当作成功结果返回');

        // —— 同一步骤里混有占位脚本 → 只报占位那一个 ——
        const mixed = { key: '333', name: '面料图', postprocess: [{ name: 'a.js', code: 'function process(i){return i;}' }, { name: 'b.js', code: '' }] };
        const rMixed = PP.checkAvailability([mixed], ['333']);
        ok(rMixed.ok === false && rMixed.problems.some(p => p.includes('b.js')), '只指出内容为空的脚本（b.js）');
        ok(!rMixed.problems.some(p => p.includes('a.js')), '已导入内容的脚本不误报');
    }

    console.log('\n【7】出厂默认五步的占位脚本遵循同一规则');
    {
        const defaults = env.CustomStepDefaults;
        ok(Array.isArray(defaults) && defaults.length === 5, '默认五步已加载');
        ok(defaults.every(s => (s.postprocess || []).length > 0), '默认五步都声明了后处理脚本');
        ok(defaults.every(s => (s.postprocess || []).every(op => !String(op.code || '').trim())), '默认脚本内容均为空（占位，待导入）');
        const r = PP.checkAvailability(defaults, defaults.map(s => s.key));
        ok(r.ok === false, '默认占位脚本 → 预检不通过（不会静默当成无后处理）');
        ok(r.problems.length >= 5, `五个步骤都被逐条指出（${r.problems.length} 条）`);
        ok(r.problems.every(p => /脚本为空/.test(p)), '每条都说明是「脚本为空」');
        ok(r.problems.every(p => /脚本为空/.test(p) && /\.js/.test(p)), '每条都带上具体脚本文件名');
    }

    console.log('\n【8】执行前配置校验 checkConfig：只查类型/空脚本，报错含编号+步骤名+脚本名');
    {
        const noneSteps = K.map(k => ({ key: k, name: '步骤' + k, postprocess: [] }));
        ok(PP.checkConfig(noneSteps, K).ok === true, '无后处理 → 配置校验通过（允许执行）');

        const empty = [{ key: '111', name: '卖点图', postprocess: [{ name: '111扩图.js', code: '' }] }];
        const r1 = PP.checkConfig(empty, ['111']);
        ok(r1.ok === false, '空脚本 → 配置校验不通过（不得静默当成无后处理）');
        ok(r1.problems.some(p => p.includes('111') && p.includes('卖点图') && p.includes('111扩图.js')), `报错同时含编号/步骤名/脚本名（${JSON.stringify(r1.problems)}）`);

        // 配置校验不碰资源：脚本非空但声明了资源时，不得因「未做资源校验」而假失败
        const withRes = [{ key: '222', name: '袖口图', postprocess: [{ name: 'a.js', code: '// @resource logo type=file name=logo.png\nfunction process(i){return i;}' }] }];
        ok(PP.checkConfig(withRes, ['222']).ok === true, '配置校验不做资源假通过也不假失败');
        ok(PP.checkAvailability(withRes, ['222'], () => false).ok === false, '传入真实资源结果时，checkAvailability 仍报缺资源');

        const badType = [{ key: '333', name: '面料图', postprocess: [{ type: 'magicWand' }] }];
        ok(PP.checkConfig(badType, ['333']).ok === false, '不支持类型 → 配置校验不通过');
        const missing = PP.checkConfig([], ['666']);
        ok(missing.ok === false && missing.problems.some(p => /666/.test(p)), '缺步骤 → 配置校验不通过');
    }

    console.log('\n【9】图像 SDK：画布能力注入 + 脚本不返回时由中枢导出画布');
    {
        const input = blobOf(100);
        const drawOnly = { type: 'customJs', script: 'CustomJsSDK.run(async ctx => { ctx.log("只绘制，不返回图片"); });' };
        const step = stepFor('222', drawOnly);

        // 提供画布能力（createSurface）→ 脚本不返回图片时由中枢导出画布
        let exportedCalled = 0;
        const fakeSurface = {
            canvas: { width: 64, height: 64 },
            ctx: { __fake: true },
            toBlob: async () => { exportedCalled++; return blobOf(77); }
        };
        const r1 = await PP.runStep(step, '222', input, { createSurface: async () => fakeSurface });
        ok(r1.ok === true && exportedCalled === 1, `脚本不返回时导出画布（导出次数 ${exportedCalled}）`);
        ok(r1.output && r1.output.size === 77, '导出结果作为该步骤输出返回');

        // 不提供画布能力 → 同一脚本必须明确失败（不得静默当成成功）
        const r2 = await PP.runStep(step, '222', input, {});
        ok(r2.ok === false && /未返回有效图片/.test(r2.error), `无画布能力 → 明确失败（${r2.error}）`);

        // 脚本能拿到中枢注入的 canvas/ctx/draw
        env.__seenCanvas = 0;
        const probe = {
            type: 'customJs',
            script: 'CustomJsSDK.run(async ctx => { if(!ctx.canvas||!ctx.ctx||!ctx.draw) throw new Error("能力缺失"); globalThis.__seenCanvas = ctx.canvas.width; });'
        };
        const r3 = await PP.runStep(stepFor('222', probe), '222', input, {
            createSurface: async () => ({ canvas: { width: 64, height: 64 }, ctx: {}, toBlob: async () => blobOf(9) }),
            draw: SDK.draw
        });
        ok(r3.ok === true && env.__seenCanvas === 64, '脚本拿到中枢注入的 canvas/ctx/draw');

        // createSurface 抛出 → 该步骤失败并带原因
        const r4 = await PP.runStep(step, '222', input, { createSurface: async () => { throw new Error('画布创建失败'); } });
        ok(r4.ok === false && /画布创建失败/.test(r4.error), `画布创建失败 → 失败（${r4.error}）`);
    }

    console.log('\n【10】ctx.draw 纯函数（单一真源）');
    {
        const [h, s, v] = SDK.draw.rgbToHsv(255, 0, 0);
        ok(Math.abs(h) < 1e-9 && Math.abs(s - 1) < 1e-9 && Math.abs(v - 1) < 1e-9, 'rgbToHsv(255,0,0) → h=0,s=1,v=1');
        const [r, g, b] = SDK.draw.hsvToRgb(0, 1, 1);
        ok(r === 255 && g === 0 && b === 0, 'hsvToRgb(0,1,1) → 255,0,0');
        ok(SDK.draw.cleanText('  a\t\tb  ') === 'a b', 'cleanText 合并空白');
        ok(SDK.draw.sameDisplayText('Solid', ' solid ') === true, 'sameDisplayText 忽略大小写/空白');
        ok(SDK.draw.tagList('Solid', '', 'Solid', 'Washable').join(',') === 'Solid,Washable', 'tagList 去空去重');
        ok(SDK.draw.splitPctLines('95%Cotton 5%Elastane').length === 2, 'splitPctLines 按百分比断行');
        ok(SDK.draw.formatWeight('250 GSM') === '250', 'formatWeight 去后缀保留数值');
        let threw = false;
        try { SDK.draw.drawTextWithStroke(null, 'x', 0, 0, '#fff', '#000', 3); } catch (_) { threw = true; }
        ok(threw, '缺 2D 上下文时 drawTextWithStroke 抛错');
        const calls = [];
        const g2 = { save() {}, restore() {}, strokeText: (t) => calls.push('stroke:' + t), fillText: (t) => calls.push('fill:' + t) };
        SDK.draw.drawTextWithStroke(g2, 'Hello', 5, 6, '#111', '#eee', 4);
        ok(calls.length === 2 && calls[0].startsWith('stroke:') && calls[1].startsWith('fill:'), `描边后填充（${calls.join('|')}）`);
    }

    console.log('\n' + '='.repeat(52));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(52));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
