/* ============================================================================
 * 套图 · 图像能力提供模块（ctx.draw 纯函数集 + 画布表面）
 *
 * 背景：222/333/666/111 等生产脚本在 SDK v2.2 里通过 ctx.draw.* 调用共享绘制能力，
 *       但本工程此前没有提供这些实现，runCustomJs 只注入 canvas:null/ctx:null/draw:null，
 *       导致任何真实脚本第一行即失败。本模块把「共享能力」集中到单一真源。
 *
 * 两点能力：
 *   1) draw.*  —— 纯函数集合（数值/文本处理 + 依赖 2D 上下文的绘制函数）
 *   2) createSurface(blob) —— 按输入图尺寸创建 canvas，把输入图绘制上去，返回 { canvas, ctx, toBlob }
 *      脚本按规范「不自己创建 canvas、不自己导出图片」，由中枢创建画布并在脚本结束后导出。
 *
 * 说明：rgbToHsv / hsvToRgb 与 111卖点图后处理.js 内联实现逐行一致（同一真源）。
 *       cleanText / sameDisplayText / tagList / splitPctLines / formatWeight / formatDisplayText
 *       为按现有脚本调用点重建的最小实现（参考扩展的 custom-js-sdk-v2.js 不在本工程内）。
 * ========================================================================== */
'use strict';

const SuiteImageSdk = (() => {

    /* ---------- 颜色 ---------- */
    // 与 111卖点图后处理.js 内联实现一致：h ∈ [0,1], s/v ∈ [0,1]
    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const v = max;
        const d = max - min;
        const s = max === 0 ? 0 : d / max;
        let h;
        if (max === min) {
            h = 0;
        } else {
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                default: h = ((r - g) / d + 4) / 6; break;
            }
        }
        return [h, s, v];
    }

    function hsvToRgb(h, s, v) {
        let r, g, b;
        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            default: r = v; g = p; b = q; break;
        }
        return [Math.floor(r * 255), Math.floor(g * 255), Math.floor(b * 255)];
    }

    /* ---------- 文本 ---------- */
    // 归一为「可比较的显示文本」：去掉不可见字符 + 合并连续空白 + 去首尾空白
    function cleanText(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 两段显示文本是否等价（忽略大小写与空白差异）
    function sameDisplayText(a, b) {
        const x = cleanText(a).toLowerCase();
        const y = cleanText(b).toLowerCase();
        return !!x && x === y;
    }

    // 把若干属性值整理成「标签候选」列表；脚本取 [0] 作为标签行，多值时按 | 拆分
    function tagList(...values) {
        const out = [];
        for (const v of values) {
            const clean = cleanText(v);
            if (!clean) continue;
            for (const part of clean.split(/[|｜]/)) {
                const p = cleanText(part);
                if (p && out.indexOf(p) < 0) out.push(p);
            }
        }
        return out;
    }

    // 百分比成分断行：95%Cotton 5%Elastane → ["95%Cotton", "5%Elastane"]
    function splitPctLines(title) {
        const s = String(title === undefined || title === null ? '' : title);
        const parts = s.split(/(?=(?:^|\s)\d+(?:\.\d+)?%)/).map(x => x.trim()).filter(Boolean);
        return parts.length > 1 ? parts : [s];
    }

    // 克重显示：去掉 GSM 等后缀，保留纯数值；无法识别为数值时原样返回
    function formatWeight(weight) {
        const s = cleanText(weight);
        if (!s) return '';
        const m = s.match(/\d+(?:\.\d+)?/);
        return m ? m[0] : s;
    }

    // 展示文本清洗（供 111 卖点逐条使用）
    function formatDisplayText(text) {
        return cleanText(text);
    }

    // 按「第一个非空值」读取（旧脚本 helper，保留兼容）
    function readField(obj, key) {
        if (!obj || key === undefined || key === null) return '';
        const v = obj[key];
        return cleanText(v);
    }
    function readFirstField(obj, keys) {
        for (const k of (keys || [])) {
            const v = readField(obj, k);
            if (v) return v;
        }
        return '';
    }

    /* ---------- 绘制（依赖调用方传入的 2D 上下文 g） ---------- */
    function requireCtx(g) {
        if (!g) throw new Error('缺少 2D 绘图上下文（ctx.ctx），无法绘制');
        return g;
    }

    // 带描边的文字：先描边同位置文字，再填充，保证任意底色下都可读
    function drawTextWithStroke(g, text, x, y, fillColor, strokeColor, offset) {
        requireCtx(g);
        const off = (offset === undefined || offset === null) ? 3 : Number(offset);
        g.save();
        g.lineJoin = 'round';
        g.lineWidth = Math.max(1, off * 2);
        g.strokeStyle = strokeColor;
        g.strokeText(String(text === undefined || text === null ? '' : text), x, y);
        g.fillStyle = fillColor;
        g.fillText(String(text === undefined || text === null ? '' : text), x, y);
        g.restore();
    }

    // 圆角矩形路径（只建路径，填充/描边由脚本自行决定）
    function drawRoundedRect(g, x, y, w, h, r) {
        requireCtx(g);
        const rr = Math.max(0, Math.min(Number(r) || 0, w / 2, h / 2));
        g.beginPath();
        g.moveTo(x + rr, y);
        g.arcTo(x + w, y, x + w, y + h, rr);
        g.arcTo(x + w, y + h, x, y + h, rr);
        g.arcTo(x, y + h, x, y, rr);
        g.arcTo(x, y, x + w, y, rr);
        g.closePath();
    }

    /* ---------- 画布表面 ---------- */
    // 按输入图尺寸创建 canvas，把原图绘制上去；脚本直接在这张画布上绘制。
    // 返回 { canvas, ctx, toBlob, dispose }。toBlob 供中枢在脚本结束后导出 PNG。
    async function createSurface(blob) {
        if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('缺少可用的输入图片 Blob');
        if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') {
            throw new Error('当前环境不支持画布能力（缺少 document / createImageBitmap）');
        }
        const bitmap = await createImageBitmap(blob);
        try {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const g = canvas.getContext('2d');
            g.drawImage(bitmap, 0, 0);
            // 同时覆盖已保存的旧脚本里的中英双语固定标签，测量与绘制必须用同一文本。
            for (const name of ['fillText','strokeText','measureText']) {
                if(typeof g[name]!=='function')continue;
                const original=g[name].bind(g);
                g[name]=(text,...args)=>original(globalThis.ExcelRow?.englishText
                    ? globalThis.ExcelRow.englishText(text) : text,...args);
            }
            return {
                canvas,
                img: bitmap,
                ctx: g,
                toBlob: () => new Promise((resolve, reject) => {
                    canvas.toBlob(b => b ? resolve(b) : reject(new Error('画布导出失败')), 'image/png');
                }),
                dispose() { bitmap.close?.(); canvas.width = 0; canvas.height = 0; }
            };
        } catch(e) {
            bitmap.close?.();throw e;
        }
    }

    const draw = {
        rgbToHsv, hsvToRgb,
        cleanText, sameDisplayText, tagList, splitPctLines,
        formatWeight, formatDisplayText, readField, readFirstField,
        drawTextWithStroke, drawRoundedRect,
    };

    return { draw, createSurface };
})();

if (typeof globalThis !== 'undefined') globalThis.SuiteImageSdk = SuiteImageSdk;
