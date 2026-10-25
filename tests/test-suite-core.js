// ============================================================
// 套图核心：结果识别 / 内容去重 / 编号映射 / 写盘校验 / 保存编排
// 直接加载生产源码 chrome_extension/suite/suite-core.js（不复制业务分支）
// 运行：node tests/test-suite-core.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'suite', 'suite-core.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

function load(opts = {}) {
    const env = { console: { log() {}, warn() {}, error() {} } };
    env.globalThis = env;
    const ctx = vm.createContext(env);
    vm.runInContext(SRC, ctx, { filename: 'suite-core.js' });
    return { run: (e) => vm.runInContext(e, ctx), C: env.SuiteCore };
}

const KEYS = [{ key: '111' }, { key: '222' }, { key: '333' }, { key: '444' }, { key: '666' }];

// 内容指纹：用"文件名里的内容标记"模拟真实内容哈希
const fpOf = (it) => {
    const m = String(it.url).match(/content_([a-z0-9]+)/i);
    return m ? 'fp:' + m[1] : null;
};

(async function main() {
    console.log('=== 套图核心 测试 ===\n');
    const { C } = load();
    const encoded=await C.recognize(['data:image/png;base64,AAAiconAAAlogoAAA'],[{key:'222'}],{expectCount:1});
    ok(encoded.ok,'图像编码随机含 icon/logo 不应被当作路径噪声');

    // ---------------- 结果识别与去重 ----------------
    console.log('【1】结果识别：只取新结果、排除噪声、按内容去重');
    {
        const urls = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map((n, i) => `https://x/content_${i}${n}`);
        const r = await C.recognize(urls, KEYS);
        ok(r.ok === true, '5 张有效 → 通过');
        ok(r.results.length === 5 && r.results[0].key === '111' && r.results[4].key === '666', '编号按固定顺序映射');
        ok(r.results.every((x, i) => x.url === urls[i]), 'URL 与编号一一对应');

        // 少于 5 张
        const r2 = await C.recognize(urls.slice(0, 4), KEYS);
        ok(r2.ok === false && /期望 5 张/.test(r2.error), `少于 5 张被拒（${r2.error}）`);
        ok(r2.diag && r2.diag.expectCount === 5 && r2.diag.afterDedupe === 4, '诊断记录预期数量与实际数量');

        // 同内容不同 URL（同一张图的两种尺寸/链接）→ 去重后不足 5 张
        const dupUrls = [
            'https://x/content_aaa_w800.png',
            'https://x/content_aaa_w1600.png',   // 同内容
            'https://x/content_bbb.png',
            'https://x/content_ccc.png',
            'https://x/content_ddd.png'
        ];
        const r3 = await C.recognize(dupUrls, KEYS, { fingerprint: fpOf });
        ok(r3.ok === false, '同内容不同 URL 被判重复 → 不通过');
        ok(r3.diag.afterDedupe === 4, `去重后 4 张（实际 ${r3.diag.afterDedupe}）`);
        ok(r3.diag.dropped.length === 1 && /content_aaa/.test(r3.diag.dropped[0].url), '诊断记录被丢弃的重复项');
        ok(r3.diag.stage === 'map', `诊断标明失败阶段（${r3.diag.stage}）`);

        // 噪声排除：头像/图标/上传预览
        const noise = ['https://x/avatar_1.png', 'https://x/icon.png', 'https://x/upload-preview.png', 'https://x/real1.png', 'https://x/real2.png'];
        const r4 = await C.recognize(noise, KEYS, { fingerprint: fpOf });
        ok(r4.diag.afterNoiseFilter === 2, `噪声被过滤（保留 ${r4.diag.afterNoiseFilter}）`);
        ok(r4.ok === false, '过滤后不足 5 张 → 不通过');

        // 没有指纹时退化为 URL 去重，并如实标注（不假装做了内容去重）
        const r5 = await C.recognize(urls, KEYS);
        ok(r5.results.every(x => x.fingerprint === null), '无指纹时明确为空，不伪造内容指纹');
    }

    // ---------------- 编号映射边界 ----------------
    console.log('\n【2】编号映射：不凭猜测硬套编号');
    {
        const items = [1, 2, 3, 4, 5].map(i => ({ url: 'u' + i, fingerprint: 'fp' + i }));
        let e1 = null; try { C.mapToOutputs(items.slice(0, 4), KEYS); } catch (e) { e1 = e.message; }
        ok(e1 && /期望 5 张/.test(e1), '数量不符 → 抛错');

        let e2 = null; try { C.mapToOutputs(items, [{ key: '111' }, { key: '111' }, { key: '333' }, { key: '444' }, { key: '666' }]); }
        catch (e) { e2 = e.message; }
        ok(e2 && /重复/.test(e2), '编号重复 → 抛错');

        let e3 = null; try { C.mapToOutputs(items, KEYS.slice(0, 4)); } catch (e) { e3 = e.message; }
        ok(e3 && /数量应为 5/.test(e3), '编号数量不足 → 抛错');

        const okMap = C.mapToOutputs(items, KEYS);
        ok(okMap.map(x => x.key).join(',') === '111,222,333,444,666', '正确映射五编号');
    }

    // ---------------- 写盘 + 回读校验 ----------------
    console.log('\n【3】写盘校验：写入→关闭→回读→验大小/类型/可解码');
    {
        const { C: c } = load();
        const mkDir = (opts = {}) => ({
            getFileHandle: async (name, o) => {
                if (opts.throwOnWrite) throw new Error('磁盘不可写');
                return {
                    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
                    getFile: async () => ({
                        size: opts.readBackSize !== undefined ? opts.readBackSize : (opts.size || 1024),
                        type: opts.type || 'image/png'
                    })
                };
            }
        });
        const blob = { size: 1024 };

        const r1 = await c.writeAndVerify(mkDir(), 'a.png', blob, { decodeSize: async () => ({ width: 800, height: 800 }) });
        ok(r1.ok === true && r1.bytes === 1024 && r1.width === 800, '正常写入并通过回读校验');

        const r2 = await c.writeAndVerify(null, 'a.png', blob);
        ok(r2.ok === false && /没有已授权/.test(r2.error), '无目录句柄 → 拒绝');

        const r3 = await c.writeAndVerify(mkDir(), 'a.png', { size: 0 });
        ok(r3.ok === false && /内容为空/.test(r3.error), '空内容 → 拒绝且不写');

        const r4 = await c.writeAndVerify(mkDir({ readBackSize: 999 }), 'a.png', blob);
        ok(r4.ok === false && /大小不一致/.test(r4.error), '回读大小不一致 → 失败（防"日志说成功但文件为空/被截断"）');

        const r5 = await c.writeAndVerify(mkDir({ type: 'text/html' }), 'a.png', blob);
        ok(r5.ok === false && /不是图片/.test(r5.error), '回读类型不是图片 → 失败');

        const r6 = await c.writeAndVerify(mkDir(), 'a.png', blob, { decodeSize: async () => ({ width: 32, height: 32 }) });
        ok(r6.ok === false && /尺寸无效/.test(r6.error), '回读解码尺寸过小 → 失败');

        const r7 = await c.writeAndVerify(mkDir(), 'a.png', blob, { decodeSize: async () => { throw new Error('坏文件'); } });
        ok(r7.ok === false, '回读无法解码 → 失败');

        const r8 = await c.writeAndVerify(mkDir({ throwOnWrite: true }), 'a.png', blob);
        ok(r8.ok === false && /写入\/校验失败/.test(r8.error), '写盘异常被捕获为失败（不包装成成功）');
    }

    // ---------------- 保存编排：全成功才 saved / 失败可只重试保存 ----------------
    console.log('\n【4】保存编排：五张全成功才 saved，失败保留结果可只重试保存');
    {
        const { C: c } = load();
        const items = KEYS.map(k => ({ key: k.key, blob: { size: 100 } }));
        const goodDeps = { fileKey: 'A__', rowNum: 412, decodeSize: async () => ({ width: 800, height: 800 }) };
        const goodDir = { getFileHandle: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }), getFile: async () => ({ size: 100, type: 'image/png' }) }) };
        const r1 = await c.saveAll(goodDir, items, goodDeps);
        ok(r1.ok === true && r1.savedCount === 5, '五张全成功 → ok');
        ok(r1.retrySaveOnly === false, '无失败时不提示只重试保存');

        // 第 333 号写盘失败（writeAndVerify 会两次调用 getFileHandle：建写入流 + 回读，故按文件名判定）
        const badDir = { getFileHandle: async (name) => { if (String(name).includes('333')) throw new Error('磁盘满'); return { createWritable: async () => ({ write: async () => {}, close: async () => {} }), getFile: async () => ({ size: 100, type: 'image/png' }) }; } };
        const r2 = await c.saveAll(badDir, items, goodDeps);
        ok(r2.ok === false && r2.savedCount === 4, `部分失败 → ok=false（成功 ${r2.savedCount}/5）`);
        ok(r2.failedKeys.join(',') === '333', `失败编号被指出（${r2.failedKeys.join(',')}）`);
        ok(r2.retrySaveOnly === true, '标记可"只重试保存"（不重新消耗额度）');
        ok(r2.results.length === 5, '保留全部已获取结果（不清空）');
    }

    // ---------------- 文件命名与结果键绑定 ----------------
    console.log('\n【5】文件与索引绑定：源表标识 + 行号 + 编号，避免跨文件/跨产品覆盖');
    {
        const { C: c } = load();
        const a = c.buildFilename('A__', 412, '111');
        const b = c.buildFilename('B__', 412, '111');
        const d = c.buildFilename('A__', 415, '111');
        ok(a !== b && a !== d, '不同源表/不同行号 → 文件名不同（不覆盖）');
        ok(/^suite_/.test(a) && /111/.test(a) && /row412/.test(a), `命名含文件标识/行号/编号（${a}）`);
        const weird = c.buildFilename('a/b\\c:d*e', 1, '222');
        ok(!/[\\/:*?"<>|]/.test(weird.replace('suite_', '')), `路径分隔符被清理（${weird}）`);

        const store = c.ResultStore('t_db', 't_store');
        const k1 = store.idOf('A__', 412, '111');
        const k2 = store.idOf('B__', 412, '111');
        const k3 = store.idOf('A__', 415, '111');
        ok(k1 !== k2 && k1 !== k3 && k2 !== k3, '索引键按 fileKey+行号+编号三元绑定');
        ok(k1 === 'A__::412::111', `索引键格式稳定（${k1}）`);
    }

    console.log('\n' + '='.repeat(52));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(52));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
