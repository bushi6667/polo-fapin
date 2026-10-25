/**
 * 111 卖点图后处理脚本 — SDK v2.2 + @contract
 *
 * @contract
 * @needs canvas:main
 * @needs row:product
 * @needs api:deepseek
 * @roles polo material|craft|design|feature
 * @roles shirt material|craft|print|feature
 * @roles t-shirt material|weight|feature|style
 * @roles hooded-sweatshirt material|craft|weight|feature
 * @roles non-hooded-sweatshirt material|craft|weight|feature
 * @supports single,batch
 * @fallback throw
 * @timeout 120000
 *
 * @resource productRow row "当前产品行（Excel）" from:currentSet.row
 *
 * 数据来源：ctx.data.excelRow —— 当前导入 Excel 的当前产品行快照（含文件/工作表/实际行号）。
 * 按真实 Excel 列名取值；「类目」列决定卖点来源：
 *   polo → 材质/工艺/设计/产品特性；shirt → 材质/工艺/印花方法/产品特性；
 *   帽衫与无帽卫衣 → 材质/工艺/面料克重/产品特性；t-shirt → 材质/面料克重/产品特性/样式。
 * ONNX session 通过 window 全局缓存跨注入复用（getOrCreateU2NetSession）。
 */
CustomJsSDK.run(async ctx => {
    const { canvas, ctx: g, img } = ctx;

    // 当前产品行快照（真实 Excel 列名；文件/工作表/实际行号一并锁定，执行中换行不影响本任务）
    const task = ctx.data.excelRow;
    if (!task) throw new Error('缺少当前产品行数据（excelRow）');
    ctx.log('[111JS] ' + task.describe() + '，列数: ' + task.headers.length);

    // 从当前产品行构建标注数据
    function buildSellingPointAnnotations() {
        const rawTitle = ctx.data.cell('标题');
        if (!rawTitle) throw new Error('「标题」列内容为空，无法标注卖点图');
        const words = rawTitle.split(/\s+/).filter(w => w);
        const titleLines = [];
        for (let i = 0; i < Math.min(words.length, 12); i += 4) {
            titleLines.push(words.slice(i, i + 4).join(' '));
        }
        const groupVal = ctx.data.category();
        let sellpointRoles;
        if (groupVal === 'polo') {
            sellpointRoles = ['material', 'craft', 'design', 'feature'];
            ctx.log('[111JS] 类目: Polo shirt → 卖点来源: 材质/工艺/设计/产品特性');
        } else if (groupVal === 'shirt') {
            sellpointRoles = ['material', 'craft', 'print', 'feature'];
            ctx.log('[111JS] 类目: Shirt → 卖点来源: 材质/工艺/印花方法/产品特性');
        } else if (groupVal === 'hooded-sweatshirt' || groupVal === 'non-hooded-sweatshirt') {
            sellpointRoles = ['material', 'craft', 'weight', 'feature'];
            ctx.log('[111JS] 类目: Hoodies & Sweatshirts → 卖点来源: 材质/工艺/面料克重/产品特性');
        } else if (groupVal === 't-shirt') {
            sellpointRoles = ['material', 'weight', 'feature', 'style'];
            ctx.log('[111JS] 类目: T-shirt → 卖点来源: 材质/面料克重/产品特性/样式');
        } else {
            throw new Error('类目未配置卖点来源：' + (groupVal || '空'));
        }

        const sellingPoints = [];
        const seen = new Set();

        for (const roleName of sellpointRoles) {
            let val = ctx.data.role(roleName).value;
            if (!val || ['none', 'n/a', 'na'].includes(val.toLowerCase())) continue;

            if (roleName === 'weight') {
                const match = val.match(/\d+\.?\d*/);
                if (match) {
                    const w = Math.round(parseFloat(match[0]));
                    if (w <= 180) {
                        val = 'Lightweight fabric ' + w + 'g';
                    } else if (w >= 240) {
                        val = 'Premium heavyweight ' + w + 'g';
                    } else {
                        val = 'Just the right weight ' + w + 'g';
                    }
                }
            }

            if (roleName === 'feature') {
                if (groupVal === 't-shirt') {
                    // t-shirt：逗号优先、不足则按换行，只取第一项
                    let parts = val.split(',').map(p => p.trim()).filter(p => p);
                    if (parts.length <= 1) {
                        parts = val.split('\n').map(p => p.trim()).filter(p => p);
                    }
                    if (parts.length > 0) {
                        const firstItem = parts[0];
                        if (!seen.has(firstItem)) {
                            seen.add(firstItem);
                            sellingPoints.push(firstItem);
                        }
                    }
                } else {
                    // 其余类目：逗号优先，最多 3 项
                    for (const sep of [',', '\n']) {
                        const parts = val.split(sep).map(p => p.trim()).filter(p => p);
                        if (parts.length > 0) {
                            for (const p of parts.slice(0, 3)) {
                                if (!seen.has(p)) {
                                    seen.add(p);
                                    sellingPoints.push(p);
                                }
                            }
                            break;
                        }
                    }
                }
            } else {
                if (!seen.has(val)) {
                    seen.add(val);
                    sellingPoints.push(val);
                }
            }
        }

        if (sellingPoints.length === 0) throw new Error('卖点属性均缺失，无法标注卖点图');

        return { titleLines, sellingPoints: sellingPoints.slice(0, 4) };
    }

    let { titleLines, sellingPoints } = buildSellingPointAnnotations();
    let w = canvas.width;
    let h = canvas.height;

    const COLS = 500;
    const ROWS = 500;
    const SCALE_FACTOR = COLS / 60;

    let brandBlacklistData = { brands: [] };

    // 中英文标题直接来自任务冻结行，按完整单词截短用于排版，不再依赖另一个模型或 API Key。
    async function compactProductTitle(title, maxChars) {
        const parts=String(title).split(/\s+\/\s+/);
        const banned=brandBlacklistData.brands||[];
        const clean=text=>banned.reduce((v,brand)=>v.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),''),text).replace(/\s+/g,' ').trim();
        const en=clean(parts[0]||'');
        const words=en.split(/\s+/);let compact='';
        for(const word of words){if((compact+' '+word).trim().length>maxChars)break;compact=(compact+' '+word).trim();}
        if(!compact)throw new Error('Product title is empty');
        return {en:compact,cn:clean(parts.slice(1).join(' / ')).slice(0,maxChars)};
    }

    // 优先用 AI 精简标题（由扩展后台代发请求，避开页面 file:// 的跨域限制）；
    // 任何失败都回退到按单词截断，保证不阻塞出图。
    async function aiCompactTitle(title, maxChars) {
        try {
            const extId = (typeof EXTENSION_ID === 'string' && EXTENSION_ID) ? EXTENSION_ID : (localStorage.getItem('polo_extension_id') || '');
            if (!extId || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return null;
            const resp = await new Promise(resolve => {
                try {
                    chrome.runtime.sendMessage(extId, { action: 'aiSimplifyTitle', title, maxChars, apiConfig: options.apiConfig }, r => {
                        if (chrome.runtime.lastError) resolve(null); else resolve(r);
                    });
                } catch (_) { resolve(null); }
            });
            if (resp && resp.ok && resp.title) return { en: resp.title, cn: '' };
            if (resp && resp.error) console.warn('[111] AI 精简失败，回退截断：' + resp.error);
        } catch (_) {}
        return null;
    }

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        let max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, v = max;
        let d = max - min;
        s = max === 0 ? 0 : d / max;
        if (max === min) {
            h = 0;
        } else {
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                case b: h = ((r - g) / d + 4) / 6; break;
            }
        }
        return [h, s, v];
    }

    function hsvToRgb(h, s, v) {
        let r, g, b;
        let i = Math.floor(h * 6);
        let f = h * 6 - i;
        let p = v * (1 - s);
        let q = v * (1 - f * s);
        let t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }
        return [Math.floor(r * 255), Math.floor(g * 255), Math.floor(b * 255)];
    }

    function getTextWidth(ctx, text) {
        let m = ctx.measureText(text);
        return m.width;
    }

    // 抠图（U2Net ONNX）已抽到共享实现：ctx.rembg.rembgRemoveBackground
    // —— 111卖点图 / 111扩图 / 444扩图 三份实现实测逻辑一致，集中到 SDK 后可避免三处漂移
    //    （session 全局缓存键、320×320 归一化、LANCZOS 回缩放等细节只维护一处）
    const { rembgRemoveBackground, getOrCreateU2NetSession } = ctx.rembg;

    // 参数 g 为画布 2D 上下文（外层解构 ctx: g 得到）。
    // 注意：参数名必须用 g，不能用 ctx —— 否则会遮蔽外层 SDK ctx，导致 ctx.log(...) 报 TypeError。
    // 函数内 ctx.log/warn 调用访问的是外层 SDK ctx 闭包（非本函数参数）。
    async function annotateImageOnCanvas(canvas, g, img, titleLines, sellingPoints) {
        sellingPoints = sellingPoints.map(sp => ctx.draw.formatDisplayText(sp));
        let n_sp = sellingPoints.length;

        let cw = w / COLS;
        let ch = h / ROWS;

        let maskCanvas = await rembgRemoveBackground(img);
        if (maskCanvas.width !== w || maskCanvas.height !== h) {
            let scaledMask = document.createElement('canvas');
            scaledMask.width = w;
            scaledMask.height = h;
            let scaledCtx = scaledMask.getContext('2d');
            scaledCtx.drawImage(maskCanvas, 0, 0, w, h);
            maskCanvas = scaledMask;
        }
        let maskCtx = maskCanvas.getContext('2d');
        let maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        let maskPx = maskData.data;

        // ===== 自适应阈值：先收集所有 mask 像素值做分布分析 =====
        let maskVals = [];
        for (let y = 0; y < maskCanvas.height; y++) {
            for (let x = 0; x < maskCanvas.width; x++) {
                maskVals.push(maskPx[(y * maskCanvas.width + x) * 4]);
            }
        }
        maskVals.sort((a, b) => a - b);
        let p50 = maskVals[Math.floor(maskVals.length * 0.5)];
        let p10 = maskVals[Math.floor(maskVals.length * 0.1)];
        let p90 = maskVals[Math.floor(maskVals.length * 0.9)];

        // 用固定阈值 30 先做一遍，如果 >= 98% 都被判为衣服，说明模型输出太软，改用自适应阈值
        let clothThreshold = 30;
        let raw_cloth_pct;
        {
            let tc = 0, tp = 0;
            for (let gy = 0; gy < ROWS; gy++) {
                for (let gx = 0; gx < COLS; gx++) {
                    let y1 = Math.floor(gy * ch), y2 = Math.floor((gy + 1) * ch);
                    let x1 = Math.floor(gx * cw), x2 = Math.floor((gx + 1) * cw);
                    for (let y = y1; y < Math.min(y2, maskCanvas.height); y++) {
                        for (let x = x1; x < Math.min(x2, maskCanvas.width); x++) {
                            tp++;
                            if (maskPx[(y * maskCanvas.width + x) * 4] > 30) tc++;
                        }
                    }
                }
            }
            raw_cloth_pct = tc / tp;
        }

        if (raw_cloth_pct > 0.98) {
            // 模型区分度不足，用 P70 作为阈值切分前景/背景
            clothThreshold = maskVals[Math.floor(maskVals.length * 0.7)];
            clothThreshold = Math.max(60, Math.min(clothThreshold, 200));
            ctx.log(`  [debug] 固定阈值30导致衣服占比${(raw_cloth_pct * 100).toFixed(1)}%，切换自适应阈值: ${clothThreshold} (P70), P10=${p10}, P50=${p50}, P90=${p90}`);
        } else {
            ctx.log(`  [debug] mask分布: P10=${p10}, P50=${p50}, P90=${p90}`);
        }

        // ===== 用最终阈值做网格分类 =====
        let gg = Array(ROWS).fill().map(() => Array(COLS).fill(false));
        let total_cloth_pixels = 0, total_pixels = 0;

        for (let gy = 0; gy < ROWS; gy++) {
            for (let gx = 0; gx < COLS; gx++) {
                let y1 = Math.floor(gy * ch), y2 = Math.floor((gy + 1) * ch);
                let x1 = Math.floor(gx * cw), x2 = Math.floor((gx + 1) * cw);
                let ct = 0, ac = 0;
                for (let y = y1; y < Math.min(y2, maskCanvas.height); y++) {
                    for (let x = x1; x < Math.min(x2, maskCanvas.width); x++) {
                        ct++;
                        if (maskPx[(y * maskCanvas.width + x) * 4] > clothThreshold) ac++;
                    }
                }
                total_pixels += ct;
                total_cloth_pixels += ac;
                if (ct > 0 && ac / ct > 0.05) gg[gy][gx] = true;
            }
        }

        ctx.log(`  [debug] rembg mask统计: 总像素=${total_pixels}, 衣服像素=${total_cloth_pixels}, 占比=${((total_cloth_pixels/total_pixels)*100).toFixed(2)}%`);

        let visited = Array(ROWS).fill().map(() => Array(COLS).fill(false));
        let components = [];

        for (let gy = 0; gy < ROWS; gy++) {
            for (let gx = 0; gx < COLS; gx++) {
                if (gg[gy][gx] && !visited[gy][gx]) {
                    let comp = [];
                    let q = [[gy, gx]];
                    visited[gy][gx] = true;
                    while (q.length > 0) {
                        let [cy, cx] = q.shift();
                        comp.push([cy, cx]);
                        let dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                        for (let [dy, dx] of dirs) {
                            let ny = cy + dy, nx = cx + dx;
                            if (ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS && gg[ny][nx] && !visited[ny][nx]) {
                                visited[ny][nx] = true;
                                q.push([ny, nx]);
                            }
                        }
                    }
                    components.push(comp);
                }
            }
        }

        if (components.length > 0) {
            let largest = components.reduce((a, b) => a.length > b.length ? a : b);
            gg = Array(ROWS).fill().map(() => Array(COLS).fill(false));
            for (let [gy, gx] of largest) {
                gg[gy][gx] = true;
            }
        }

        let g_pixels = [];
        let bg_pixels = [];
        let imgData = g.getImageData(0, 0, w, h);
        let pxData = imgData.data;

        for (let gy = 0; gy < ROWS; gy++) {
            for (let gx = 0; gx < COLS; gx++) {
                let y1 = Math.floor(gy * ch);
                let y2 = Math.floor((gy + 1) * ch);
                let x1 = Math.floor(gx * cw);
                let x2 = Math.floor((gx + 1) * cw);
                let rs = 0, gs = 0, bs = 0, ct = 0;
                for (let y = y1; y < Math.min(y2, h); y++) {
                    for (let x = x1; x < Math.min(x2, w); x++) {
                        let idx = (y * w + x) * 4;
                        rs += pxData[idx];
                        gs += pxData[idx + 1];
                        bs += pxData[idx + 2];
                        ct++;
                    }
                }
                if (ct > 0) {
                    let avg_r = Math.floor(rs / ct);
                    let avg_g = Math.floor(gs / ct);
                    let avg_b = Math.floor(bs / ct);
                    if (gg[gy][gx]) {
                        g_pixels.push([avg_r, avg_g, avg_b]);
                    } else {
                        bg_pixels.push([avg_r, avg_g, avg_b]);
                    }
                }
            }
        }

        let avg_garm = [128, 128, 128];
        if (g_pixels.length > 0) {
            avg_garm = [
                Math.floor(g_pixels.reduce((sum, p) => sum + p[0], 0) / g_pixels.length),
                Math.floor(g_pixels.reduce((sum, p) => sum + p[1], 0) / g_pixels.length),
                Math.floor(g_pixels.reduce((sum, p) => sum + p[2], 0) / g_pixels.length)
            ];
        }

        let avg_bg = [128, 128, 128];
        if (bg_pixels.length > 0) {
            avg_bg = [
                Math.floor(bg_pixels.reduce((sum, p) => sum + p[0], 0) / bg_pixels.length),
                Math.floor(bg_pixels.reduce((sum, p) => sum + p[1], 0) / bg_pixels.length),
                Math.floor(bg_pixels.reduce((sum, p) => sum + p[2], 0) / bg_pixels.length)
            ];
        }

        let bg_lum = avg_bg[0] * 299 + avg_bg[1] * 587 + avg_bg[2] * 114;
        let is_dark = bg_lum < 130000;
        let tc = is_dark ? [255, 255, 255] : [40, 40, 50];

        ctx.log(`  [debug] 衣服颜色: RGB(${avg_garm.join(',')}), 背景颜色: RGB(${avg_bg.join(',')}), 背景亮度=${bg_lum}, is_dark=${is_dark}, 标题颜色=${tc}`);

        let gys = [];
        for (let gy = 0; gy < ROWS; gy++) {
            if (gg[gy].some(x => x)) gys.push(gy);
        }
        let g_top = gys.length > 0 ? gys[0] : Math.floor(ROWS / 2);
        let g_bot = gys.length > 0 ? gys[gys.length - 1] : Math.floor(ROWS * 3 / 4);

        let gxs = [];
        for (let gx = 0; gx < COLS; gx++) {
            for (let gy = 0; gy < ROWS; gy++) {
                if (gg[gy][gx]) { gxs.push(gx); break; }
            }
        }
        let g_left = gxs.length > 0 ? gxs[0] : Math.floor(COLS / 4);
        let g_right = gxs.length > 0 ? gxs[gxs.length - 1] : Math.floor(COLS * 3 / 4);

        let zone = Array(ROWS).fill().map(() => Array(COLS).fill(0));
        for (let gy = 0; gy < g_top; gy++) {
            for (let gx = 0; gx < COLS; gx++) zone[gy][gx] = 2;
        }
        for (let gy = 0; gy < ROWS; gy++) {
            for (let gx = 0; gx < COLS; gx++) {
                if (gg[gy][gx]) zone[gy][gx] = 1;
            }
        }

        let tr2 = g_top;
        let cloth_row_range = [g_top, g_bot];

        let cloth_cells = [];
        for (let gy = 0; gy < ROWS; gy++) {
            for (let gx = 0; gx < COLS; gx++) {
                if (gg[gy][gx]) cloth_cells.push([gy, gx]);
            }
        }

        let cloth_center_gx = Math.floor(COLS / 2);
        if (cloth_cells.length > 0) {
            let cloth_gxs = cloth_cells.map(c => c[1]);
            cloth_center_gx = Math.floor(cloth_gxs.reduce((sum, gx) => sum + gx, 0) / cloth_gxs.length);
        }

        let cloth_position = 'center';
        let left_blank_cols = g_left;
        let right_blank_cols = COLS - 1 - g_right;
        let total_cols = left_blank_cols + right_blank_cols;
        let diff_ratio = total_cols > 0 ? Math.abs(left_blank_cols - right_blank_cols) / total_cols : 0;

        ctx.log(`  位置检测: 左边空白列=${left_blank_cols}, 右边空白列=${right_blank_cols}, 比例差=${(diff_ratio * 100).toFixed(2)}%`);
        if (left_blank_cols < right_blank_cols && diff_ratio > 0.15) {
            cloth_position = 'left';
            ctx.log('  → 衣服靠左');
        } else if (right_blank_cols < left_blank_cols && diff_ratio > 0.15) {
            cloth_position = 'right';
            ctx.log('  → 衣服靠右');
        } else {
            cloth_position = 'center';
            ctx.log('  → 衣服居中');
        }

        // 垂直方向区域信息提取：统计某列/某行的连通格子，用于卖点胶囊的纵向定位
        function get_region_info_v(data, name, default_gy) {
            if (!data || data.length === 0) {
                return { name: name, gy_center: default_gy, gxs: [], count: 0,
                         gx_min: 0, gx_max: 0, gy_min: 0, gy_max: 0,
                         full_data: data, orient: 'v' };
            }
            let all_gxs = [];
            let all_gys = [];
            let total_cells = 0;
            for (let [gy, gxs_row] of data) {
                all_gxs = all_gxs.concat(gxs_row);
                all_gys.push(gy);
                total_cells += gxs_row.length;
            }
            return {
                name: name,
                gy_center: data[Math.floor(data.length / 2)][0],
                gxs: [...new Set(all_gxs)],
                count: total_cells,
                gx_min: Math.min(...all_gxs),
                gx_max: Math.max(...all_gxs),
                gy_min: Math.min(...all_gys),
                gy_max: Math.max(...all_gys),
                full_data: data,
                orient: 'v'
            };
        }

        // 水平方向区域信息提取：与 get_region_info_v 对称，用于横向定位
        function get_region_info_h(data, name, default_gy) {
            if (!data || data.length === 0) {
                return { name: name, gy_center: default_gy, gxs: [], count: 0,
                         gx_min: 0, gx_max: 0, gy_min: 0, gy_max: 0,
                         full_data: data, orient: 'h' };
            }
            let cols = data.map(d => d[0]);
            let all_row_gys = [];
            let total_cells = 0;
            for (let [gx, row_gys] of data) {
                all_row_gys = all_row_gys.concat(row_gys);
                total_cells += row_gys.length;
            }
            all_row_gys.sort((a, b) => a - b);
            return {
                name: name,
                gy_center: all_row_gys[Math.floor(all_row_gys.length / 2)],
                gxs: cols,
                count: total_cells,
                gx_min: Math.min(...cols),
                gx_max: Math.max(...cols),
                gy_min: Math.min(...all_row_gys),
                gy_max: Math.max(...all_row_gys),
                full_data: data,
                orient: 'h'
            };
        }

        let selected_regions = [];

        if (cloth_position === 'left') {
            ctx.log('  靠右生成区域（衣服靠左，标注放右侧）：');
            let total_rows = g_bot - g_top + 1;
            let zone_top = Math.max(0, g_top - Math.floor(total_rows * 0.05));
            let zone_bot = Math.min(ROWS - 1, g_bot + Math.floor(total_rows * 0.10));
            let zone_height = zone_bot - zone_top + 1;

            let scan_start_gx = g_right;
            let scan_end_gx = COLS - 1;
            let band_height = Math.floor(zone_height / n_sp);

            let regions = [];
            for (let i = 0; i < n_sp; i++) {
                let band_start = zone_top + i * band_height;
                let band_end = zone_top + (i + 1) * band_height - 1;
                if (i === n_sp - 1) band_end = zone_bot;
                let band_center_gy = Math.floor((band_start + band_end) / 2);
                let region_data = [];
                for (let gy = band_start; gy <= band_end; gy++) {
                    let blank_gxs = [];
                    for (let gx = scan_start_gx; gx <= scan_end_gx; gx++) {
                        if (zone[gy][gx] === 0) blank_gxs.push(gx);
                    }
                    if (blank_gxs.length > 0) region_data.push([gy, blank_gxs]);
                }
                regions.push(get_region_info_v(region_data, `右侧${i + 1}`, band_center_gy));
            }

            regions = regions.filter(r => r.count > 0);
            for (let reg of regions) {
                ctx.log(`    ${reg.name}: ${reg.count}个格子`);
            }

            let sp_sorted = sellingPoints.map((_, i) => i).sort((a, b) => sellingPoints[b].length - sellingPoints[a].length);
            let regions_sorted = regions.map((r, i) => ({ r, i })).sort((a, b) => b.r.count - a.r.count);
            selected_regions = Array(n_sp).fill(null);
            let used_regions = new Set();

            for (let idx of sp_sorted) {
                for (let { r, i } of regions_sorted) {
                    if (!used_regions.has(i)) {
                        selected_regions[idx] = r;
                        used_regions.add(i);
                        break;
                    }
                }
            }

            for (let i = 0; i < n_sp; i++) {
                if (!selected_regions[i]) {
                    selected_regions[i] = {
                        name: `右侧${i + 1}`,
                        gy_center: zone_top + (i + 0.5) * band_height,
                        gxs: [g_right + 5],
                        count: 1,
                        gx_min: g_right,
                        gx_max: COLS - 1,
                        full_data: [],
                        orient: 'v'
                    };
                }
            }

        } else if (cloth_position === 'right') {
            ctx.log('  靠左生成区域（衣服靠右，标注放左侧）：');
            let total_rows = g_bot - g_top + 1;
            let zone_top = Math.max(0, g_top - Math.floor(total_rows * 0.05));
            let zone_bot = Math.min(ROWS - 1, g_bot + Math.floor(total_rows * 0.10));
            let zone_height = zone_bot - zone_top + 1;

            let scan_start_gx = 0;
            let scan_end_gx = g_left;
            let band_height = Math.floor(zone_height / n_sp);

            let regions = [];
            for (let i = 0; i < n_sp; i++) {
                let band_start = zone_top + i * band_height;
                let band_end = zone_top + (i + 1) * band_height - 1;
                if (i === n_sp - 1) band_end = zone_bot;
                let band_center_gy = Math.floor((band_start + band_end) / 2);
                let region_data = [];
                for (let gy = band_start; gy <= band_end; gy++) {
                    let blank_gxs = [];
                    for (let gx = scan_start_gx; gx <= scan_end_gx; gx++) {
                        if (zone[gy][gx] === 0) blank_gxs.push(gx);
                    }
                    if (blank_gxs.length > 0) region_data.push([gy, blank_gxs]);
                }
                regions.push(get_region_info_v(region_data, `左侧${i + 1}`, band_center_gy));
            }

            regions = regions.filter(r => r.count > 0);
            for (let reg of regions) {
                ctx.log(`    ${reg.name}: ${reg.count}个格子`);
            }

            let sp_sorted = sellingPoints.map((_, i) => i).sort((a, b) => sellingPoints[b].length - sellingPoints[a].length);
            let regions_sorted = regions.map((r, i) => ({ r, i })).sort((a, b) => b.r.count - a.r.count);
            selected_regions = Array(n_sp).fill(null);
            let used_regions = new Set();

            for (let idx of sp_sorted) {
                for (let { r, i } of regions_sorted) {
                    if (!used_regions.has(i)) {
                        selected_regions[idx] = r;
                        used_regions.add(i);
                        break;
                    }
                }
            }

            for (let i = 0; i < n_sp; i++) {
                if (!selected_regions[i]) {
                    selected_regions[i] = {
                        name: `左侧${i + 1}`,
                        gy_center: zone_top + (i + 0.5) * band_height,
                        gxs: [g_left - 5],
                        count: 1,
                        gx_min: 0,
                        gx_max: g_left,
                        full_data: [],
                        orient: 'v'
                    };
                }
            }

        } else {
            let total_rows = g_bot - g_top + 1;
            let half = Math.floor(total_rows / 2);
            let band1_gy_center = Math.floor((g_top + (g_top + half - 1)) / 2);
            let band2_gy_center = Math.floor(((g_top + half) + g_bot) / 2);

            let band_height_old = Math.floor(3 * SCALE_FACTOR);
            let edge_margin_old = Math.floor(1 * SCALE_FACTOR);

            let region0_data = [];
            let region1_data = [];
            let region2_data = [];
            let region3_data = [];

            let startGy = Math.max(edge_margin_old, band1_gy_center - band_height_old);
            let endGy = Math.min(ROWS - edge_margin_old, band1_gy_center + band_height_old);
            for (let gy = startGy; gy <= endGy; gy++) {
                if (gy < tr2) continue;
                let left_blank = [];
                for (let gx = edge_margin_old; gx < cloth_center_gx; gx++) {
                    if (zone[gy][gx] === 0) left_blank.push(gx);
                }
                let right_blank = [];
                for (let gx = cloth_center_gx; gx < COLS - edge_margin_old; gx++) {
                    if (zone[gy][gx] === 0) right_blank.push(gx);
                }
                if (left_blank.length > 0) region0_data.push([gy, left_blank]);
                if (right_blank.length > 0) region1_data.push([gy, right_blank]);
            }

            startGy = Math.max(edge_margin_old, band2_gy_center - band_height_old);
            endGy = Math.min(ROWS - edge_margin_old, band2_gy_center + band_height_old);
            for (let gy = startGy; gy <= endGy; gy++) {
                let left_blank = [];
                for (let gx = edge_margin_old; gx < cloth_center_gx; gx++) {
                    if (zone[gy][gx] === 0) left_blank.push(gx);
                }
                let right_blank = [];
                for (let gx = cloth_center_gx; gx < COLS - edge_margin_old; gx++) {
                    if (zone[gy][gx] === 0) right_blank.push(gx);
                }
                if (left_blank.length > 0) region2_data.push([gy, left_blank]);
                if (right_blank.length > 0) region3_data.push([gy, right_blank]);
            }

            let region0 = get_region_info_v(region0_data, '左上', band1_gy_center);
            let region1 = get_region_info_v(region1_data, '右上', band1_gy_center);
            let region2 = get_region_info_v(region2_data, '左下', band2_gy_center);
            let region3 = get_region_info_v(region3_data, '右下', band2_gy_center);

            let gx_span = g_right - g_left;
            let gx_left_inner = g_left + Math.floor(gx_span / 5);
            let gx_right_inner = g_right - Math.floor(gx_span / 5);
            let bottom_mid_data = [];

            let startGx = Math.max(edge_margin_old, gx_left_inner);
            let endGx = Math.min(COLS - edge_margin_old, gx_right_inner);
            for (let gx = startGx; gx <= endGx; gx++) {
                let below_blank = [];
                for (let gy = g_bot + 1; gy < ROWS - edge_margin_old; gy++) {
                    if (zone[gy][gx] === 0) below_blank.push(gy);
                }
                if (below_blank.length > 0) bottom_mid_data.push([gx, below_blank]);
            }
            let region_bottom_mid = get_region_info_h(bottom_mid_data, '下中', g_bot + band_height_old);

            let middle_gy = Math.floor((band1_gy_center + band2_gy_center) / 2);
            let middle_data = [];

            startGy = Math.max(edge_margin_old, middle_gy - band_height_old);
            endGy = Math.min(ROWS - edge_margin_old, middle_gy + band_height_old);
            for (let gy = startGy; gy <= endGy; gy++) {
                if (gy < tr2) continue;
                let right_blank = [];
                for (let gx = cloth_center_gx; gx < COLS - edge_margin_old; gx++) {
                    if (zone[gy][gx] === 0) right_blank.push(gx);
                }
                if (right_blank.length > 0) middle_data.push([gy, right_blank]);
            }
            let region_right_mid = get_region_info_v(middle_data, '右中', middle_gy);

            let left_middle_data = [];
            for (let gy = startGy; gy <= endGy; gy++) {
                if (gy < tr2) continue;
                let left_blank = [];
                for (let gx = edge_margin_old; gx < cloth_center_gx; gx++) {
                    if (zone[gy][gx] === 0) left_blank.push(gx);
                }
                if (left_blank.length > 0) left_middle_data.push([gy, left_blank]);
            }
            let region_left_mid = get_region_info_v(left_middle_data, '左中', middle_gy);

            ctx.log('  区域格子数：');
            ctx.log(`    左上: ${region0.count}个格子`);
            ctx.log(`    右上: ${region1.count}个格子`);
            ctx.log(`    左下: ${region2.count}个格子`);
            ctx.log(`    右下: ${region3.count}个格子`);
            ctx.log(`    下中: ${region_bottom_mid.count}个格子`);
            ctx.log(`    右中: ${region_right_mid.count}个格子`);
            ctx.log(`    左中: ${region_left_mid.count}个格子`);

            if (n_sp === 4) {
                selected_regions = [region0, region2, region1, region3];
            } else if (n_sp === 3) {
                let opt_a = [region0, region2, region_right_mid];
                let opt_b = [region_left_mid, region1, region3];
                let opt_c = [region1, region0, region_bottom_mid];
                let score = rgs => rgs.reduce((sum, r) => sum + r.count, 0);
                selected_regions = [opt_a, opt_b, opt_c].reduce((a, b) => score(a) > score(b) ? a : b);
            } else if (n_sp === 2) {
                let opt_a = [region0, region3];
                let opt_b = [region2, region1];
                let opt_c = [region0, region1];
                let opt_d = [region2, region3];
                let score = rgs => rgs.reduce((sum, r) => sum + r.count, 0);
                selected_regions = [opt_a, opt_b, opt_c, opt_d].reduce((a, b) => score(a) > score(b) ? a : b);
            } else if (n_sp === 1) {
                let candidates = [region0, region2, region1, region3, region_bottom_mid];
                selected_regions = [candidates.reduce((a, b) => a.count > b.count ? a : b)];
            } else {
                let all_regions = [region0, region2, region1, region3, region_bottom_mid, region_right_mid, region_left_mid];
                selected_regions = all_regions.sort((a, b) => b.count - a.count).slice(0, n_sp);
            }
        }

        let [rHsv, gHsv, bHsv] = avg_bg.map(x => x / 255.0);
        let [hue, sat, val] = rgbToHsv(rHsv, gHsv, bHsv);
        let base_region_colors = [];
        for (let offset of [0, 0.08, -0.08, 0.5, 0.25, -0.15]) {
            let h2 = (hue + offset) % 1.0;
            let s2 = Math.max(0.25, Math.min(0.55, sat * 0.7));
            let v2 = is_dark ? 0.75 : 0.60;
            let [rr, gg2, bb] = hsvToRgb(h2, s2, v2);
            base_region_colors.push([rr, gg2, bb, 255]);
        }
        if (sat < 0.15 && val > 0.8) {
            base_region_colors = [[70, 75, 85, 255], [100, 80, 65, 255], [65, 85, 80, 255], [85, 70, 90, 255], [90, 60, 60, 255], [75, 90, 70, 255]];
        }

        let region_color_map = {
            '左上': base_region_colors[0], '右上': base_region_colors[1],
            '左下': base_region_colors[2], '右下': base_region_colors[3],
            '下中': base_region_colors[4], '右中': base_region_colors[1],
            '左中': base_region_colors[5],
            '右侧1': base_region_colors[0], '右侧2': base_region_colors[1],
            '右侧3': base_region_colors[2], '右侧4': base_region_colors[3],
            '左侧1': base_region_colors[0], '左侧2': base_region_colors[1],
            '左侧3': base_region_colors[2], '左侧4': base_region_colors[3],
            '默认': base_region_colors[0]
        };

        for (let reg of selected_regions) {
            reg.color = region_color_map[reg.name] || base_region_colors[0];
        }

        let cwp = w / COLS;
        let chp = h / ROWS;

        let fs2 = Math.floor(Math.min(w, h) * 0.025);
        fs2 = Math.max(24, Math.min(fs2, 120)) + 5;

        let rawTitle = titleLines.filter(x => x).join(' ');
        // AI 精简优先（用户要求：标题用 AI 精简，而不是机械截断）
        let simplified = (await aiCompactTitle(rawTitle, 60)) || await compactProductTitle(rawTitle, 50);
        let full_title = simplified.en;
        ctx.log(`  原标题: ${rawTitle}`);
        ctx.log(`  简化后: ${full_title}`);
        if (simplified.cn) ctx.log(`  中文翻译: ${simplified.cn}`);

        let total_chars = full_title.replace(/\s/g, '').length;
        let words = full_title.split(' ');
        let n_words = words.length;

        let n_lines;
        if (total_chars <= 18 || n_words === 1) {
            n_lines = 1;
        } else {
            n_lines = 2;
        }

        let lines;
        if (n_lines === 1) {
            lines = [full_title];
        } else if (n_words === 2) {
            lines = [words[0], words[1]];
        } else {
            let target = total_chars / 2;
            let cum = 0;
            let split_idx = Math.floor(n_words / 2);
            let best_diff = Infinity;
            for (let i = 1; i < n_words; i++) {
                cum += words[i - 1].length;
                let diff = Math.abs(cum - target);
                if (diff < best_diff) {
                    best_diff = diff;
                    split_idx = i;
                }
            }
            split_idx = Math.max(1, Math.min(split_idx, n_words - 1));
            lines = [words.slice(0, split_idx).join(' '), words.slice(split_idx).join(' ')];
        }

        lines = lines.filter(l => l && l.trim());
        let n = lines.length;
        let ah = tr2 * (h / ROWS);

        let titleColor = is_dark ? '#ffffff' : '#282832';
        let fs = Math.floor(ah * 0.35);
        fs = Math.max(24, Math.min(fs, 110));
        g.font = `bold ${fs}px Arial, sans-serif`;

        while (Math.max(...lines.map(l => getTextWidth(g, l))) > w - 30 && fs > 14) {
            fs -= 2;
            g.font = `bold ${fs}px Arial, sans-serif`;
        }

        let lh = fs + Math.max(4, Math.floor(fs / 6));
        while (n * lh > ah - 10 && fs > 14) {
            fs -= 2;
            g.font = `bold ${fs}px Arial, sans-serif`;
            lh = fs + Math.max(4, Math.floor(fs / 6));
        }

        if (fs <= fs2) {
            ctx.log(`  标题字号(${fs}px)小于等于标注字号(${fs2}px)，不显示标题`);
        } else {
            lh = fs + Math.max(4, Math.floor(fs / 6));
            let th2 = n * lh;
            let sy = Math.floor((ah - th2) / 2);
            g.fillStyle = titleColor;
            g.textBaseline = 'top';
            for (let i = 0; i < lines.length; i++) {
                let lw = getTextWidth(g, lines[i]);
                let lx = Math.floor((w - lw) / 2);
                g.fillText(lines[i], lx, sy + i * lh);
            }
            ctx.log(`  标题 ${n}行 (共${total_chars}字符) 字号:${fs}px 颜色:${titleColor} -> [${lines.join(', ')}]`);
        }

        let selling_sorted = [...sellingPoints].sort((a, b) => b.length - a.length);
        let regions_sorted = selected_regions.map((r, i) => ({ r, i })).sort((a, b) => b.r.count - a.r.count);

        let assignments = [];
        for (let i = 0; i < regions_sorted.length && i < selling_sorted.length; i++) {
            assignments.push([regions_sorted[i].r, selling_sorted[i]]);
        }

        g.font = `${fs2}px Arial, sans-serif`;

        function capsulePath(g, bx_, by_, pw_, ph_, r_) {
            // 四角圆角矩形，与 Python ImageDraw.rounded_rectangle 语义一致
            g.beginPath();
            g.moveTo(bx_ + r_, by_);
            g.lineTo(bx_ + pw_ - r_, by_);
            g.arcTo(bx_ + pw_, by_, bx_ + pw_, by_ + r_, r_);
            g.lineTo(bx_ + pw_, by_ + ph_ - r_);
            g.arcTo(bx_ + pw_, by_ + ph_, bx_ + pw_ - r_, by_ + ph_, r_);
            g.lineTo(bx_ + r_, by_ + ph_);
            g.arcTo(bx_, by_ + ph_, bx_, by_ + ph_ - r_, r_);
            g.lineTo(bx_, by_ + r_);
            g.arcTo(bx_, by_, bx_ + r_, by_, r_);
            g.closePath();
        }

        for (let [region, text] of assignments) {
            let gy_center = region.gy_center;
            let gxs = region.gxs;
            if (!gxs || gxs.length === 0) continue;

            let full_data = region.full_data || [];
            let orient = region.orient || 'v';
            let row_gxs = null;

            if (orient === 'v') {
                for (let [g, row] of full_data) {
                    if (g === gy_center) {
                        row_gxs = row;
                        break;
                    }
                }
                if (row_gxs === null && full_data.length > 0) {
                    row_gxs = full_data.reduce((a, b) => Math.abs(a[0] - gy_center) < Math.abs(b[0] - gy_center) ? a : b)[1];
                }
            } else {
                row_gxs = full_data.filter(([gx, gys]) => gys.includes(gy_center)).map(([gx]) => gx);
            }

            if (!row_gxs) row_gxs = [...gxs];
            row_gxs.sort((a, b) => a - b);

            let gx_min = row_gxs[0];
            let gx_max = row_gxs[row_gxs.length - 1];
            let rx1 = Math.floor(gx_min * cwp);
            let rx2 = Math.floor((gx_max + 1) * cwp);
            let reg_gy_min = region.gy_min != null ? region.gy_min : Math.max(0, Math.floor(gy_center) - 3);
            let reg_gy_max = region.gy_max != null ? region.gy_max : Math.min(ROWS - 1, Math.floor(gy_center) + 3);
            let ry1 = Math.floor(reg_gy_min * chp);
            let ry2 = Math.floor((reg_gy_max + 1) * chp);
            let center_x = Math.floor((rx1 + rx2) / 2);

            let parts = text.split(/[,，\n;；]/).map(p => p.trim()).filter(p => p);
            let seen = new Set();
            let raw_lines = [];
            for (let part of parts) {
                if (!seen.has(part)) {
                    seen.add(part);
                    raw_lines.push(part);
                }
            }

            let region_w = rx2 - rx1;
            let cap_bw = Math.floor(region_w * 0.9);
            let cap_text_w = Math.max(fs2 * 6, cap_bw - 50);

            let text_lines = [];
            for (let raw_ln of raw_lines) {
                let ln_w = getTextWidth(g, raw_ln);
                if (ln_w <= cap_text_w) {
                    text_lines.push(raw_ln);
                } else {
                    let text_words = raw_ln.split(' ');
                    let current = '';
                    for (let word of text_words) {
                        let trial = current ? current + ' ' + word : word;
                        let trial_w = getTextWidth(g, trial);
                        if (trial_w <= cap_text_w) {
                            current = trial;
                        } else {
                            if (current) text_lines.push(current);
                            current = word;
                        }
                    }
                    if (current) text_lines.push(current);
                }
            }

            if (text_lines.length > 5) {
                let rest = text_lines.slice(4).join(' ');
                text_lines = text_lines.slice(0, 4).concat([rest]);
            }

            let num_lines = text_lines.length;
            let max_tw = Math.max(...text_lines.map(ln => getTextWidth(g, ln)));
            let line_gap = Math.floor(fs2 / 3);
            let bh_mult;
            if (num_lines === 1) {
                bh_mult = 2;
            } else if (num_lines === 2) {
                bh_mult = 1.3;
            } else {
                bh_mult = 1.1;
            }

            let px_bw = Math.floor(max_tw + 60);
            let px_bh = Math.floor((num_lines * fs2 + (num_lines - 1) * line_gap) * bh_mult);

            px_bw = Math.floor(px_bw * 1.1);
            px_bh = Math.floor(px_bh * 1.1);

            let img_center_x = Math.floor(w / 2);
            let region_center_x = Math.floor((rx1 + rx2) / 2);
            let region_center_y = Math.floor((ry1 + ry2) / 2);

            let bx, by;
            if (num_lines === 1) {
                region_w = rx2 - rx1;
                let new_cx;
                if (region_center_x < img_center_x) {
                    new_cx = rx2 - Math.floor(region_w / 3);
                } else {
                    new_cx = rx1 + Math.floor(region_w / 3);
                }
                let dist = region_center_x < img_center_x ? (rx2 - new_cx) : (new_cx - rx1);
                ctx.log(`  [debug] ${region.name}: 区域宽=${region_w}px, 新cx=${new_cx}, 中心(cx)距离衣服端: ${dist}px`);
                bx = new_cx - Math.floor(px_bw / 2);
                by = region_center_y - Math.floor(px_bh / 2);
            } else {
                bx = center_x - Math.floor(px_bw / 2);
                by = region_center_y - Math.floor(px_bh / 2);
            }

            bx = Math.max(5, Math.min(w - px_bw - 5, bx));
            by = Math.max(5, Math.min(h - px_bh - 5, by));

            let r2 = Math.min(Math.floor(px_bh / 2), 50);

            let blurPad = 20;
            let cropX = Math.max(0, bx - blurPad);
            let cropY = Math.max(0, by - blurPad);
            let cropW = Math.min(w - cropX, px_bw + blurPad * 2);
            let cropH = Math.min(h - cropY, px_bh + blurPad * 2);

            let cropCanvas = document.createElement('canvas');
            cropCanvas.width = cropW;
            cropCanvas.height = cropH;
            let cropCtx = cropCanvas.getContext('2d');
            cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            cropCtx.filter = 'blur(8px)';
            cropCtx.drawImage(cropCanvas, 0, 0);
            cropCtx.filter = 'none';

            let maskCanvas2 = document.createElement('canvas');
            maskCanvas2.width = w;
            maskCanvas2.height = h;
            let maskCtx2 = maskCanvas2.getContext('2d');
            capsulePath(maskCtx2, bx, by, px_bw, px_bh, r2);
            maskCtx2.fillStyle = '#ffffff';
            maskCtx2.fill();

            let frostedCanvas = document.createElement('canvas');
            frostedCanvas.width = w;
            frostedCanvas.height = h;
            let frostedCtx = frostedCanvas.getContext('2d');
            frostedCtx.drawImage(cropCanvas, cropX, cropY);
            frostedCtx.globalCompositeOperation = 'destination-in';
            frostedCtx.drawImage(maskCanvas2, 0, 0);
            frostedCtx.globalCompositeOperation = 'source-over';

            g.globalAlpha = 0.75;
            g.drawImage(frostedCanvas, 0, 0);
            g.globalAlpha = 1.0;

            capsulePath(g, bx, by, px_bw, px_bh, r2);
            g.fillStyle = 'rgba(255, 255, 255, 0.18)';
            g.fill();

            g.save();
            capsulePath(g, bx, by, px_bw, px_bh, r2);
            g.clip();
            for (let gy = 0; gy < px_bh; gy++) {
                let alpha = Math.floor(50 * Math.max(0, 1 - (gy / px_bh) * 2));
                g.fillStyle = `rgba(255, 255, 255, ${alpha / 255})`;
                g.fillRect(bx, by + gy, px_bw, 1);
            }
            g.restore();

            capsulePath(g, bx, by, px_bw, px_bh, r2);
            g.strokeStyle = 'rgba(255, 255, 255, 0.78)';
            g.lineWidth = 3;
            g.stroke();

            let r3 = r2 + 4;
            capsulePath(g, bx - 4, by - 4, px_bw + 8, px_bh + 8, r3);
            g.strokeStyle = `rgba(${avg_bg[0]}, ${avg_bg[1]}, ${avg_bg[2]}, 0.78)`;
            g.lineWidth = 3;
            g.stroke();

            g.save();
            capsulePath(g, bx, by, px_bw, px_bh, r2);
            g.clip();
            let rInner = Math.max(0, r2 - 2);
            capsulePath(g, bx + 2, by + 2, px_bw - 4, px_bh - 4, rInner);
            g.strokeStyle = 'rgba(255, 255, 255, 0.31)';
            g.lineWidth = 1;
            g.stroke();
            g.restore();

            g.font = `${fs2}px Arial, sans-serif`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillStyle = '#141414';

            let total_h = num_lines * fs2 + (num_lines - 1) * line_gap;
            let start_y = by + Math.floor((px_bh - total_h) / 2);

            for (let i = 0; i < num_lines; i++) {
                let ly = start_y + i * (fs2 + line_gap) + Math.floor(fs2 / 2);
                g.fillText(text_lines[i], bx + Math.floor(px_bw / 2), ly);
            }

            ctx.log(`  放置 ${text} 在 ${region.name} (${num_lines}行, 胶囊${px_bw}x${px_bh}px)`);
        }
    }

    brandBlacklistData = await ctx.assets.readJson('brand_blacklist.json');

    // 传 g（画布上下文）而非 ctx（SDK 上下文），避免函数内 ctx.log 被遮蔽
    await annotateImageOnCanvas(canvas, g, img, titleLines, sellingPoints);
    ctx.log('  OK 111标注完成');
}, {
  timeoutMs: 120000,
  preserveLegacySignals: true,
});
