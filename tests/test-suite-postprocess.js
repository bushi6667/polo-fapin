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
const ctx = vm.createContext(env);
vm.runInContext(SRC, ctx, { filename: 'suite-postprocess.js' });
const PP = env.SuitePostprocess;

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

    console.log('\n' + '='.repeat(52));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(52));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
