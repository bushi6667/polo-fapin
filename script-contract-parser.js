/* 脚本头部声明解析器（自参考扩展 pages/utils/script-contract-parser.js 迁入）。
 * 用途：读取 JS 脚本自身声明的「所需内容」，供自定义步骤配置自动识别资源。
 * 暴露：window.parseResourceDeclarations / window.ScriptContractParser.parseScriptContract */
(() => {
    'use strict';

    const MIN_TIMEOUT = 3000;
    const MAX_TIMEOUT = 600000;
    const DEFAULT_TIMEOUT = 120000;
    const VALID_FALLBACKS = Object.freeze(['alert', 'skip', 'throw']);
    const DEFAULT_SUPPORTS = Object.freeze(['single', 'batch', 'pipeline']);

    // 解析脚本头部第一个 /** */ 块中的 @contract 标签；无 @contract 返回 null（旧脚本跳过校验）
    function parseScriptContract(src) {
        if (typeof src !== 'string' || !src) return null;
        const start = src.indexOf('/**');
        if (start < 0) return null;
        const end = src.indexOf('*/', start + 3);
        if (end < 0) return null;
        const block = src.slice(start + 3, end);
        if (!/@contract\b/.test(block)) return null;

        const needs = [], produces = [];
        let supports = null, fallback = 'alert', timeout = DEFAULT_TIMEOUT;

        for (const raw of block.split('\n')) {
            const line = raw.replace(/^\s*\*\s?/, '').trim();
            if (!line.startsWith('@')) continue;
            const cut = tag => {
                const rest = line.slice(tag.length).trim();
                const i = rest.indexOf(';');
                return (i >= 0 ? rest.slice(0, i) : rest).trim();
            };
            if (line.startsWith('@needs')) {
                const pair = cut('@needs'), i = pair.indexOf(':');
                if (i > 0) {
                    const type = pair.slice(0, i).trim().toLowerCase(), key = pair.slice(i + 1).trim();
                    if (type && key) needs.push({ type, key });
                }
                continue;
            }
            if (line.startsWith('@produces')) {
                const pair = cut('@produces'), i = pair.indexOf(':');
                if (i > 0) {
                    const type = pair.slice(0, i).trim().toLowerCase(), key = pair.slice(i + 1).trim();
                    if (type && key) produces.push({ type, key });
                }
                continue;
            }
            if (line.startsWith('@supports')) {
                supports = cut('@supports').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                continue;
            }
            if (line.startsWith('@fallback')) {
                const val = cut('@fallback').toLowerCase();
                fallback = VALID_FALLBACKS.includes(val) ? val : 'alert';
                continue;
            }
            if (line.startsWith('@timeout')) {
                const num = parseInt(cut('@timeout'), 10);
                if (!isNaN(num) && num > 0) timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, num));
            }
        }

        return Object.freeze({
            needs: Object.freeze(needs),
            produces: Object.freeze(produces),
            supports: Object.freeze(supports || DEFAULT_SUPPORTS),
            fallback,
            timeout,
        });
    }

    // 解析 @resource 行级声明：@resource <key> <file|folder|row> ["说明"] [from:<source>] ["文件名"]
    // source: currentSet.images | currentSet.data | currentSet.row | user（默认 user）
    //        简写 from:currentSet = from:currentSet.images
    // row：当前导入 Excel 的当前产品行（不是文件，也不是文件夹），脚本用 ctx.data.excelRow 读取
    function parseResourceDeclarations(jsCode) {
        const declarations = [], seenKeys = new Set();
        for (const line of String(jsCode || '').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
                if (declarations.length > 0) break;
                continue;
            }
            const match = trimmed.match(/@resource\s+(\w+)\s+(file|folder|row)(?:\s+"([^"]*)")?(?:\s+from:(\S+))?(?:\s+"([^"]*)")?/);
            if (!match) continue;
            const [, key, type, label, source, fileName] = match;
            const actualSource = (source || 'user') === 'currentSet' ? 'currentSet.images' : (source || 'user');
            if (seenKeys.has(key)) throw new Error('资源 key 重复: ' + key);
            seenKeys.add(key);
            const decl = { key, type, label: label || key, source: actualSource };
            if(new RegExp('@optional\\s+'+key+'\\b').test(jsCode))decl.optional=true;
            if (type === 'file' && fileName) decl.fileName = fileName;
            declarations.push(decl);
        }
        return declarations;
    }

    // 声明优先；常量 cell/role 调用可自动发现。动态字段用 @columns/@roles 显式声明，避免执行脚本来探测。
    function requirements(src, category) {
        const code = String(src || ''), columns = new Set(), roles = new Set();
        for (const m of code.matchAll(/@columns\s+([^\r\n]+)/g)) {
            const [scope, ...rest] = m[1].trim().split(/\s+/);
            if (scope === '*' || scope === category) rest.join(' ').split('|').map(s=>s.trim()).filter(Boolean).forEach(s=>columns.add(s));
        }
        for (const m of code.matchAll(/@roles\s+([^\r\n]+)/g)) {
            const [scope, ...rest] = m[1].trim().split(/\s+/);
            if (scope === '*' || scope === category) rest.join(' ').split('|').map(s=>s.trim()).filter(Boolean).forEach(s=>roles.add(s));
        }
        for (const m of code.matchAll(/(?:ctx\.data\.cell|\b_v)\(\s*['"]([^'"]+)['"]\s*\)/g)) columns.add(m[1]);
        for (const m of code.matchAll(/ctx\.data\.(?:optionalRole|role)\(\s*['"]([^'"]+)['"]\s*\)/g)) roles.add(m[1]);
        // 兼容已保存的旧版脚本：按类目分支赋给角色数组，再逐个 role() 读取。
        // 只识别常量数组与等值/或条件，不运行脚本，不把所有类目的字段合并。
        for (const m of code.matchAll(/if\s*\(([^)]+)\)\s*\{\s*(\w+)\s*=\s*\[([^\]]+)\]/g)) {
            const condition=m[1], names=[...condition.matchAll(/\w+\s*===\s*['"]([^'"]+)['"]/g)].map(v=>v[1]);
            if (!names.includes(category) || !new RegExp('of\\s+'+m[2]+'\\b').test(code) || !/ctx\.data\.role\(\s*\w+\s*\)/.test(code)) continue;
            for(const item of m[3].matchAll(/['"]([\w]+)['"]/g))roles.add(item[1]);
        }
        if (/ctx\.data\.category\(/.test(code)) columns.add('类目');
        for (const role of roles) {
            const col = window.CategoryFieldRules.optionalColumnOf(role, category);
            if (col) columns.add(col);
        }
        return { resources: parseResourceDeclarations(code), contract: parseScriptContract(code), columns: [...columns] };
    }
    window.parseResourceDeclarations = parseResourceDeclarations;
    window.ScriptContractParser = Object.freeze({ parseScriptContract, requirements });
})();
