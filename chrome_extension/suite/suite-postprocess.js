/* ============================================================================
 * 套图 · 后处理执行器
 *
 * 对齐参考扩展 pages/doubao/postprocess.js 的模型：
 *   - 资源：脚本头部 @resource 声明（key + type:file|folder + 来源），从【已授权目录句柄】读取
 *   - 步骤：type = 'none' | 'builtin' | 'customJs'
 *   - 每个输出编号按其步骤配置独立执行，按配置顺序
 *
 * 硬性约束（对齐验收要求）：
 *   - 未配置 → 直接返回原图（状态与配置一致，不假装处理过）
 *   - 配置不支持 / 资源缺失 / 脚本报错 → 明确失败并给出 编号+原因，绝不静默跳过
 *   - 原始图 / 中间结果 / 最终图 分离返回，失败后可【只重试处理】而不重新生图
 *   - 可用性可在生成前预检（checkAvailability），尽量避免生成后才发现缺资源
 * ========================================================================== */
'use strict';

const SuitePostprocess = (() => {
    const BUILTIN = ['trimBorder', 'padSquare', 'resizeMax'];   // 参考扩展内置处理的最小集
    const SUPPORTED = ['none', 'builtin', 'customJs'];

    /* ---------- @resource 声明解析 ---------- */
    // 形如：// @resource key=logoImg type=file name=logo.png
    function parseResourceDeclarations(source) {
        const out = [];
        const re = /@resource\s+([^\n\r]+)/g;
        let m;
        while ((m = re.exec(String(source || '')))) {
            const parts = m[1].trim().split(/\s+/);
            const decl = {};
            // 参考格式：首个【不带 =】的标记即为 key（如 `@resource logoImg type=file name=logo.png`）；
            // 同时兼容显式 `key=xxx` 写法
            for (const p of parts) {
                const i = p.indexOf('=');
                if (i > 0) decl[p.slice(0, i)] = p.slice(i + 1);
                else if (!decl.key) decl.key = p;
            }
            if (decl.key) out.push({ key: decl.key, type: decl.type || 'file', name: decl.name || '' });
        }
        return out;
    }

    /* ---------- 配置校验 ---------- */
    // 生成前可用性预检：返回 {ok, problems[]}，problems 精确到编号
    function checkAvailability(steps, outputKeys, resolveResource) {
        const problems = [];
        const keys = (outputKeys || []).map(k => String((k && k.key) || k).trim());
        for (const key of keys) {
            const step = (steps || []).find(s => (s.outputKeys || []).some(o => (typeof o === 'string' ? o : (o.key || '')).toString().trim() === key));
            if (!step) { problems.push(`${key}：缺少该编号的步骤配置`); continue; }
            const pp = step.postprocess;
            if (!pp || !pp.type || pp.type === 'none') continue;
            if (SUPPORTED.indexOf(pp.type) < 0) { problems.push(`${key}：不支持的后处理类型「${pp.type}」`); continue; }
            if (pp.type === 'builtin' && BUILTIN.indexOf(pp.action) < 0) {
                problems.push(`${key}：内置后处理「${pp.action || '(空)'}」不支持`); continue;
            }
            if (pp.type === 'customJs') {
                if (!pp.script || !String(pp.script).trim()) { problems.push(`${key}：自定义脚本为空`); continue; }
                for (const decl of parseResourceDeclarations(pp.script)) {
                    const has = typeof resolveResource === 'function' ? resolveResource(key, decl) : true;
                    if (!has) problems.push(`${key}：缺少声明资源 ${decl.key}（type=${decl.type}${decl.name ? ' name=' + decl.name : ''}）`);
                }
            }
        }
        return { ok: problems.length === 0, problems };
    }

    /* ---------- 资源加载（只用真实授权句柄） ---------- */
    async function loadResources(scriptSource, ctx) {
        const decls = parseResourceDeclarations(scriptSource);
        const resources = {};
        for (const d of decls) {
            const handle = ctx && typeof ctx.getHandle === 'function' ? await ctx.getHandle(d) : null;
            if (!handle) throw new Error(`资源未授权或缺失：${d.key}（type=${d.type}）`);
            if (d.type === 'folder') {
                const files = {};
                for await (const [name, h] of handle.entries()) {
                    if (h.kind === 'file') files[name] = await h.getFile();
                }
                resources[d.key] = files;
            } else {
                let fh = handle;
                if (handle.kind !== 'file') {
                    if (!d.name) throw new Error(`资源 ${d.key} 是文件夹但未声明 name`);
                    fh = await handle.getFileHandle(d.name);
                }
                resources[d.key] = await fh.getFile();
            }
        }
        return resources;
    }

    /* ---------- 执行 ---------- */
    // deps: { blobs: {key: Blob}, loadImageBlob: (blob)=>ImageBitmap, canvasFactory }
    async function runStep(step, key, inputBlob, ctx = {}) {
        const pp = (step && step.postprocess) || { type: 'none' };
        if (!pp.type || pp.type === 'none') {
            return { ok: true, output: inputBlob, applied: 'none', key };
        }
        if (SUPPORTED.indexOf(pp.type) < 0) {
            return { ok: false, key, error: `不支持的后处理类型「${pp.type}」`, applied: pp.type };
        }
        try {
            if (pp.type === 'builtin') {
                const out = await runBuiltin(pp, inputBlob, ctx);
                return { ok: true, output: out, applied: 'builtin:' + pp.action, key };
            }
            // customJs：脚本在受控作用域内执行，出入参显式传递
            const resources = await loadResources(pp.script, ctx);
            const out = await runCustomJs(pp, key, inputBlob, resources, ctx);
            return { ok: true, output: out, applied: 'customJs', key };
        } catch (e) {
            return { ok: false, key, error: (e && e.message) || '后处理异常', applied: pp.type };
        }
    }

    async function runBuiltin(pp, blob, ctx) {
        if (!ctx || typeof ctx.transform !== 'function') throw new Error('缺少图像变换能力（ctx.transform）');
        const action = pp.action;
        if (BUILTIN.indexOf(action) < 0) throw new Error(`内置后处理不支持：${action}`);
        return await ctx.transform(blob, action, pp.options || {});
    }

    async function runCustomJs(pp, key, blob, resources, ctx) {
        const src = String(pp.script);
        // 受控执行：不暴露网络/DOM，只给入参、资源与受限输出
        const factory = new Function('input', 'resources', 'options', 'log', `"use strict";${src}\n;return (typeof process === 'function') ? process(input, resources, options) : input;`);
        const log = (m) => console.log(`[suite-postprocess][${key}] ${m}`);
        const out = await factory(blob, resources, pp.options || {}, log);
        if (!out || typeof out.arrayBuffer !== 'function' || !out.size) {
            throw new Error('自定义脚本未返回有效图片 Blob');
        }
        return out;
    }

    /* ---------- 编排：按编号顺序处理，任一失败即整体失败 ---------- */
    async function runAll(steps, outputKeys, blobs, ctx = {}) {
        const results = [];
        for (const key of outputKeys.map(k => String((k && k.key) || k).trim())) {
            const step = (steps || []).find(s => (s.outputKeys || []).some(o => (typeof o === 'string' ? o : (o.key || '')).toString().trim() === key));
            const input = blobs[key];
            if (!input) { results.push({ ok: false, key, error: '缺少该编号的原始图片', applied: 'none' }); continue; }
            const r = await runStep(step, key, input, ctx);
            results.push(r);
            if (!r.ok && !(step && step.postprocess && step.postprocess.continueOnError)) break;
        }
        const failed = results.filter(r => !r.ok);
        return {
            ok: failed.length === 0 && results.length === outputKeys.length,
            results,
            failedKeys: failed.map(r => r.key),
            // 已有处理结果可继续保存；失败时只需重试处理，不重新消耗生图额度
            retryProcessOnly: failed.length > 0
        };
    }

    return { BUILTIN, SUPPORTED, parseResourceDeclarations, checkAvailability, loadResources, runStep, runAll };
})();

if (typeof globalThis !== 'undefined') globalThis.SuitePostprocess = SuitePostprocess;
