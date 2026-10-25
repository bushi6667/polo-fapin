/* ============================================================================
 * 套图 · 后处理执行器
 *
 * 对齐参考扩展 pages/doubao/postprocess.js 的模型：
 *   - 资源：脚本头部 @resource 声明（key + type:file|folder + 来源），从【已授权目录句柄】读取
 *   - 步骤：type = 'none' | 'builtin' | 'customJs'
 *   - 每个输出编号按其步骤配置独立执行，按配置顺序
 *
 * 硬性约束（对齐验收要求）：
 *   - 未配置后处理 → 直接返回原图（状态与配置一致，不假装处理过）
 *   - 已配置脚本但内容为空（含默认占位脚本）→ 预检与执行都明确报错，指出【步骤名 + 脚本名】，绝不静默跳过
 *   - 配置不支持 / 资源缺失 / 脚本报错 → 明确失败并给出 编号+原因，绝不静默跳过
 *   - 原始图 / 中间结果 / 最终图 分离返回，失败后可【只重试处理】而不重新生图
 *   - 可用性可在生成前预检（checkAvailability），尽量避免生成后才发现缺资源
 * ========================================================================== */
'use strict';

const SuitePostprocess = (() => {
    const BUILTIN = ['trimBorder', 'padSquare', 'resizeMax'];   // 参考扩展内置处理的最小集
    const SUPPORTED = ['none', 'builtin', 'customJs'];

    /* ---------- @resource 声明解析 ---------- */
    /* 支持两种写法（与 script-contract-parser.js 保持一致的语义）：
     *   位置式：// @resource productRow row "当前产品行（Excel）" from:currentSet.row
     *   旧键值式：// @resource logoImg type=file name=logo.png
     * type 可为 file | folder | row；row 表示「当前导入 Excel 的当前产品行」，由 ctx.data 提供，不读文件句柄。 */
    function parseResourceDeclarations(source) {
        const out = [];
        const re = /@resource\s+([^\n\r]+)/g;
        let m;
        while ((m = re.exec(String(source || '')))) {
            const line = m[1].trim();
            const quoted = (line.match(/"([^"]*)"/g) || []).map(s => s.replace(/"/g, ''));
            const bare = line.replace(/"[^"]*"/g, ' ').trim().split(/\s+/).filter(Boolean);
            const decl = { key: '', type: '', name: '', label: '', source: '' };
            if (bare.length >= 2 && /^(file|folder|row)$/.test(bare[1])) {
                decl.key = bare[0];
                decl.type = bare[1];
                decl.label = quoted[0] || '';
                const fromTok = bare.find(t => t.indexOf('from:') === 0);
                if (fromTok) decl.source = fromTok.slice(5);
                if (quoted[1]) decl.name = quoted[1];
            } else {
                for (const p of bare) {
                    const i = p.indexOf('=');
                    if (i > 0) decl[p.slice(0, i)] = p.slice(i + 1);
                    else if (!decl.key) decl.key = p;
                }
            }
            if (decl.key) out.push(Object.assign({ key: decl.key, type: decl.type || 'file', name: decl.name || '', label: decl.label || '', source: decl.source || '' },new RegExp('@optional\\s+'+decl.key+'\\b').test(source)?{optional:true}:{}));
        }
        return out;
    }

    /* ---------- 步骤 ↔ 输出编号 ---------- */
    // 面板配置用 step.key；旧配置用 step.outputKeys。两者都要能定位，避免出现两套互不相通的配置。
    function keyOf(step) {
        if (!step) return '';
        if (step.key !== undefined && step.key !== null && String(step.key).trim()) return String(step.key).trim();
        const first = (step.outputKeys || [])[0];
        return String((first && first.key) || first || '').trim();
    }
    function stepFor(steps, key) {
        return (steps || []).find(s =>
            keyOf(s) === key || (s.outputKeys || []).some(o => String((o && o.key) || o || '').trim() === key)) || null;
    }
    // 面板的后处理是数组（多个脚本按序执行），条目形如 { name, path, code }（脚本源码在 code）；
    // 旧配置是单个对象，形如 { type:'customJs', script }。统一成执行器认识的 { type, script }。
    // 「无后处理」与「已配置脚本但内容为空」必须区分开：
    //   - 完全没有条目（或 {type:'none'}）→ 无后处理，允许执行，直接用原图；
    //   - 有条目、认得出是脚本（有 name/path）但 code 为空 → 已配置但脚本为空，必须明确报错，不得静默跳过。
    // 只有既没有 type、也没有任何脚本标识的空壳条目才被丢弃（等同未配置）。
    function normalizeOperation(op) {
        if (!op) return null;
        if (op.type) {
            return op.type === 'customJs' ? Object.assign({}, op, { script: op.script || op.code || '' }) : op;
        }
        const code = op.script || op.code || '';
        const name = op.name || op.path || '';
        if (!code && !name) return null;
        return Object.assign({}, op, { type: 'customJs', script: code });
    }
    // 后处理条目的可读标识（用于报错与预检信息：必须同时给出步骤名与脚本名）
    function scriptLabel(op) {
        return String((op && (op.name || op.path)) || '').trim() || '未命名脚本';
    }
    // 面板的后处理是数组（多个脚本按序执行）；旧配置是单个对象。两种都要支持。
    function operationsOf(postprocess) {
        if (!postprocess) return [];
        const list = Array.isArray(postprocess) ? postprocess : [postprocess];
        return list.map(normalizeOperation).filter(Boolean);
    }

    /* ---------- 执行上下文的数据域 ---------- */
    // 行数据来自【任务启动时冻结的行快照】（ctx.excelRow），不由脚本或页面实时读取；
    // 与 CustomJsDataDomain.create({excelRow, resources}) 同一形态。
    function dataDomain(ctx, resources) {
        const excelRow = (ctx && ctx.excelRow) || null;
        const merged = Object.assign({}, (ctx && ctx.resources) || {}, resources || {});
        const factory = (typeof globalThis !== 'undefined' && globalThis.CustomJsDataDomain) || null;
        if (factory) return factory.create({ excelRow, resources: merged, englishOnly: true });
        return {
            excelRow,
            hasResource: async key => Object.prototype.hasOwnProperty.call(merged, key),
            loadResource: async key => {
                if (!Object.prototype.hasOwnProperty.call(merged, key)) throw new Error('缺少资源：' + key);
                return merged[key];
            },
        };
    }

    /* ---------- 配置校验 ---------- */
    // 统一的「配置是否可执行」校验（单一真源）：逐条检查所有选定步骤的后处理类型与脚本内容，
    // 返回 {ok, problems[]}，problems 精确到「输出编号 + 步骤名 + 脚本名」。
    // resolveResource 未传入时只做配置校验，资源校验留给执行期用【冻结快照 + 真实授权句柄】完成。
    function checkProblems(steps, outputKeys, resolveResource) {
        const problems = [];
        const keys = (outputKeys || []).map(k => String((k && k.key) || k).trim());
        for (const key of keys) {
            const step = stepFor(steps, key);
            if (!step) { problems.push(`${key}：缺少该编号的步骤配置`); continue; }
            const stepName = String(step.name || '').trim();
            const where = stepName ? `${key} ${stepName}` : key;   // 报错必须同时指出输出编号与步骤名
            for (const op of operationsOf(step.postprocess)) {
                if (!op.type || op.type === 'none') continue;
                if (SUPPORTED.indexOf(op.type) < 0) { problems.push(`${where}：不支持的后处理类型「${op.type}」`); continue; }
                if (op.type === 'builtin' && BUILTIN.indexOf(op.action) < 0) {
                    problems.push(`${where}：内置后处理「${op.action || '(空)'}」不支持`); continue;
                }
                if (op.type !== 'customJs') continue;
                // 已配置脚本但内容为空（含默认占位脚本）→ 必须在执行前明确报错，不得静默当成「无后处理」
                if (!op.script || !String(op.script).trim()) {
                    problems.push(`${where}：「${scriptLabel(op)}」已配置为后处理脚本但脚本为空，请先导入脚本内容再执行`); continue;
                }
                for (const decl of parseResourceDeclarations(op.script)) {
                    if (decl.type === 'row') continue;   // 行数据来自任务冻结快照，不需要文件句柄
                    if (op.resourceValues && (op.resourceValues[decl.key]?.value || op.resourceValues[decl.key]?.ref)) continue;
                    if (decl.optional) continue;
                    if (decl.source === 'user') { problems.push(`${where}：「${scriptLabel(op)}」请先选择资源 ${decl.label || decl.key}`); continue; }
                    if (typeof resolveResource !== 'function') continue;
                    if (!resolveResource(key, decl)) problems.push(`${where}：「${scriptLabel(op)}」缺少声明资源 ${decl.key}（type=${decl.type}${decl.name ? ' name=' + decl.name : ''}）`);
                }
            }
        }
        return { ok: problems.length === 0, problems };
    }
    // 执行前的配置校验：只查类型与空脚本，不要求输出目录授权（否则会遮盖空脚本错误），也不做假资源通过
    function checkConfig(steps, outputKeys) { return checkProblems(steps, outputKeys, null); }
    // 生成前可用性预检：配置校验 + 资源校验（resolveResource 必须给出真实结果）
    function checkAvailability(steps, outputKeys, resolveResource) { return checkProblems(steps, outputKeys, resolveResource); }

    async function selectedResources(op) {
        const selected={};
        for(const [key,value] of Object.entries(op.resourceValues || {})) {
            if(value.ref) {
                const record=await SuiteCore.ResultStore('polo_script_resources').get('resources',0,value.ref);
                if(!record?.meta?.value)throw new Error(`资源 ${key} 的已保存文件不存在，请重新选择`);
                selected[key]=record.meta.value;
            } else selected[key]=value.value;
        }
        return selected;
    }
    // 与面板同一需求分析器；生成前检查真实表头及已选文件，防止消耗额度后才发现配置失效。
    async function checkInputs(steps, outputKeys, excelRow) {
        const result=checkConfig(steps,outputKeys);
        if(!result.ok)return result;
        const parser=globalThis.ScriptContractParser || globalThis.window?.ScriptContractParser;
        for(const key of outputKeys) for(const op of operationsOf(stepFor(steps,key)?.postprocess)) {
            if(op.type!=='customJs')continue;
            try {
                if(!parser?.requirements)throw new Error('脚本需求分析器未加载');
                const req=parser.requirements(op.script,excelRow.category());
                for(const column of req.columns){
                    const value=excelRow.cell(column);
                    if(globalThis.ExcelRow?.englishText)globalThis.ExcelRow.englishText(value);
                }
                await selectedResources(op);
            } catch(e) {result.problems.push(`${key}：「${scriptLabel(op)}」${e.message}`);}
        }
        result.ok=result.problems.length===0;return result;
    }

    /* ---------- 资源加载（只用真实授权句柄） ---------- */
    async function loadResources(scriptSource, ctx) {
        const decls = parseResourceDeclarations(scriptSource);
        const resources = {};
        for (const d of decls) {
            if (d.type === 'row') continue;   // 行数据由 ctx.excelRow 提供，不走文件句柄
            if (ctx?.selectedResources && Object.prototype.hasOwnProperty.call(ctx.selectedResources,d.key)) {
                resources[d.key]=ctx.selectedResources[d.key]; continue;
            }
            const handle = ctx && typeof ctx.getHandle === 'function' ? await ctx.getHandle(d) : null;
            if (!handle && d.optional)continue;
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
    // deps: { excelRow, resources, getHandle, transform }
    async function runStep(step, key, inputBlob, ctx = {}) {
        const ops = operationsOf(step && step.postprocess);
        if (!ops.length) {
            return { ok: true, output: inputBlob, applied: 'none', key };
        }
        const applied = [];
        let current = inputBlob;
        for (const op of ops) {
            if (!op.type || op.type === 'none') { applied.push('none'); continue; }
            if (SUPPORTED.indexOf(op.type) < 0) {
                return { ok: false, key, error: `不支持的后处理类型「${op.type}」`, applied: op.type };
            }
            try {
                if (op.type === 'builtin') {
                    current = await runBuiltin(op, current, ctx);
                    applied.push('builtin:' + op.action);
                } else {
                    // 已配置脚本但内容为空 → 明确失败（不静默当原图）；与预检一致，防止绕过预检的执行路径漏掉
                    if (!String(op.script || '').trim()) {
                        const stepName = String((step && step.name) || '').trim();
                        return { ok: false, key, error: `${stepName ? stepName + '：' : ''}「${scriptLabel(op)}」尚未导入脚本内容，无法执行后处理`, applied: 'customJs' };
                    }
                    const selected = await selectedResources(op);
                    const resources = await loadResources(op.script, Object.assign({},ctx,{ selectedResources:selected }));
                    current = await runCustomJs(op, key, current, resources, ctx);
                    applied.push('customJs');
                }
            } catch (e) {
                return { ok: false, key, error: (e && e.message) || '后处理异常', applied: op.type };
            }
        }
        return { ok: true, output: current, applied: applied.join('+'), key };
    }

    async function runBuiltin(pp, blob, ctx) {
        if (!ctx || typeof ctx.transform !== 'function') throw new Error('缺少图像变换能力（ctx.transform）');
        const action = pp.action;
        if (BUILTIN.indexOf(action) < 0) throw new Error(`内置后处理不支持：${action}`);
        return await ctx.transform(blob, action, pp.options || {});
    }

    /* 脚本入口支持两种写法：
     *   CustomJsSDK.run(async ctx => {...}, opts)   —— 生产脚本（222/333/666/111…）
     *   function process(input, resources, options) —— 旧式薄壳
     * 两种都拿到同一个 ctx.data（行快照 + 资源），不会出现「脚本读页面内存」的第二条数据通路。 */
    async function runCustomJs(pp, key, blob, resources, ctx) {
        const src = String(pp.script).replace(/action:\s*'aiSimplifyTitle',\s*title,\s*maxChars/g,"action: 'aiSimplifyTitle', title, maxChars, apiConfig: options.apiConfig");
        const log = (m) => console.log(`[suite-postprocess][${key}] ${m}`);
        const data = dataDomain(ctx, resources);
        let captured = null;
        const CustomJsSDK = {
            version: '2.2',
            run(fn, opts) { captured = { fn, opts: opts || {} }; },
        };
        // 图像能力：优先用调用方注入的 canvas/ctx2d；没有现成画布、但提供了 createSurface 时，
        // 按【输入图尺寸】现建画布并把原图绘制上去（脚本不自己创建 canvas，也不自己导出图片，由中枢导出）。
        let canvas = (ctx && ctx.canvas) || null;
        let g2d = (ctx && ctx.ctx2d) || null;
        const draw = (ctx && ctx.draw) || null;
        let surface = null;
        if (!canvas && ctx && typeof ctx.createSurface === 'function') {
            surface = await ctx.createSurface(blob);
            canvas = surface.canvas;
            g2d = surface.ctx;
        }
        // User-authored scripts run in this page's realm; this is not a security sandbox.
        // A missing entry point is a configuration error, never a successful no-op.
        try {
        const factory = new Function('input', 'resources', 'options', 'log', 'data', 'CustomJsSDK', `"use strict";${src}
;if (typeof process === 'function') return { legacy: process(input, resources, options) };
return null;`);
        const legacy = await factory(blob, resources, pp.options || {}, log, data, CustomJsSDK);
        let out;
        if (legacy && legacy.legacy !== undefined) {
            out = await legacy.legacy;
        } else if (captured) {
            out = await captured.fn({
                data,
                log,
                warn: m => console.warn(`[suite-postprocess][${key}] ${m}`),
                error: m => { throw new Error(m); },
                input: blob,
                resources,
                // 图像 SDK：canvas / 2d 上下文 / 绘制工具由中枢按输入图创建并注入；
                // 二者都缺失时脚本会明确报错，不会被当成「处理成功」。
                canvas,
                img: surface?.img || ctx.img || null,
                rembg: ctx.rembg || (typeof SuiteRemBg==='function' ? SuiteRemBg(log) : null),
                assets: ctx.assets || (typeof SuiteRuntime!=='undefined' ? SuiteRuntime : null),
                ctx: g2d,
                draw,
                contract: (ctx && ctx.contract) || null,
            });
        } else {
            throw new Error('自定义脚本未提供入口：需要 CustomJsSDK.run(fn, opts) 或 process(input, resources, options)');
        }
        if (out && typeof out.arrayBuffer === 'function' && out.size) return out;
        // 脚本未 return 图片：按规范「脚本不自己导出图片、由中枢导出」，把中枢画的画布导出为图片。
        // 没有可导出的画布时仍按失败处理（不静默当成成功）。
        if (surface && typeof surface.toBlob === 'function') {
            const exported = await surface.toBlob();
            if (exported && typeof exported.arrayBuffer === 'function' && exported.size) return exported;
        }
        throw new Error('自定义脚本未返回有效图片 Blob');
        } finally { surface?.dispose?.(); }
    }

    /* ---------- 编排：按编号顺序处理，任一失败即整体失败 ---------- */
    async function runAll(steps, outputKeys, blobs, ctx = {}) {
        const results = [];
        for (const key of outputKeys.map(k => String((k && k.key) || k).trim())) {
            const step = stepFor(steps, key);
            const input = blobs[key];
            if (!input) { results.push({ ok: false, key, error: '缺少该编号的原始图片', applied: 'none' }); continue; }
            const r = await runStep(step, key, input, ctx);
            results.push(r);
            const ops = operationsOf(step && step.postprocess);
            if (!r.ok && !ops.some(op => op.continueOnError)) break;
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

    return { BUILTIN, SUPPORTED, parseResourceDeclarations, keyOf, stepFor, normalizeOperation, scriptLabel, operationsOf, checkConfig, checkInputs, checkAvailability, loadResources, runStep, runAll };
})();

if (typeof globalThis !== 'undefined') globalThis.SuitePostprocess = SuitePostprocess;
