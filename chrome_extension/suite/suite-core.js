/* ============================================================================
 * 套图核心：结果识别 / 内容去重 / 编号映射 / 写盘校验 / 结果持久化
 *
 * 分三块，全部为可独立测试的纯逻辑（外部 API 由调用方注入，便于本地验证）：
 *   1) 结果识别   normalizeUrls / dedupeByContent / mapToOutputs
 *   2) 写盘校验   writeAndVerify（写入 → 关闭流 → 重新读取 → 校验大小/类型/可解码/尺寸）
 *   3) 结果持久化 ResultStore（IndexedDB：按 fileKey+row+key 绑定，避免跨产品混图）
 *
 * 原则（对齐验收要求）：
 *  - URL 不同不足以证明图片不同 → 必须按内容指纹去重
 *  - 数量不足 / 重复 / 编号不确定 → 一律失败，不用旧图补齐、不改逐张生成
 *  - 只有 5 张最终文件都保存并校验成功，才允许 saved → completed
 *  - 写盘失败保留已获取结果，恢复时优先重试保存（不重新消耗额度）
 * ========================================================================== */
'use strict';

const SuiteCore = (() => {
    const REQUIRED_COLORS = ['white', 'black', 'gray', 'navy'];
    const DEFAULT_EXPECT = 5;

    /* ---------------- 1) 结果识别 ---------------- */

    // 过滤明显不是生成结果的来源：上传预览/头像/图标/占位
    const NOISE_HINT = /(avatar|icon|emoji|logo|placeholder|upload[-_]?preview|thumb[-_]?empty)/i;

    function normalizeUrls(raw) {
        const out = [];
        for (const item of (raw || [])) {
            const url = typeof item === 'string' ? item : (item && (item.url || item.src));
            if (typeof url !== 'string' || !url.trim()) continue;
            if (NOISE_HINT.test(url)) continue;
            out.push({ url: url.trim(), w: (item && item.w) || 0, h: (item && item.h) || 0 });
        }
        return out;
    }

    /* 内容去重：fingerprint 由调用方注入（浏览器用内容哈希/ImageBitmap 采样），
       这里只负责"同一指纹只保留一张"。没有指纹时退化为 URL 去重并明确标注。 */
    async function dedupeByContent(items, fingerprint) {
        const seen = new Map();
        const uniq = [];
        const dropped = [];
        for (const it of items) {
            let fp = null;
            if (typeof fingerprint === 'function') {
                try { fp = await fingerprint(it); } catch (_) { fp = null; }
            }
            const key = fp || ('url:' + it.url);
            if (seen.has(key)) { dropped.push({ url: it.url, dupOf: seen.get(key) }); continue; }
            seen.set(key, it.url);
            uniq.push(Object.assign({}, it, { fingerprint: fp }));
        }
        return { uniq, dropped };
    }

    /* 编号映射：严格按照参考扩展的固定输出顺序一一对应。
       任何数量不符、重复或缺图都抛错（绝不把任意五张硬套编号）。 */
    function mapToOutputs(items, outputKeys, expectCount = DEFAULT_EXPECT) {
        const keys = (outputKeys || []).map(k => String((k && k.key) || k).trim());
        if (keys.length !== expectCount) throw new Error(`输出编号数量应为 ${expectCount}，实际 ${keys.length}`);
        if (new Set(keys).size !== keys.length) throw new Error('输出编号存在重复');
        if (!Array.isArray(items) || items.length !== expectCount) {
            throw new Error(`期望 ${expectCount} 张不同图片，实际 ${items ? items.length : 0} 张`);
        }
        return keys.map((key, i) => ({ key, url: items[i].url, fingerprint: items[i].fingerprint || null, index: i }));
    }

    /* 一次性完成：规范化 → 内容去重 → 编号映射；失败时返回可诊断信息 */
    async function recognize(rawImages, outputKeys, opts = {}) {
        const expectCount = opts.expectCount || DEFAULT_EXPECT;
        const diag = { expectCount, rawCount: (rawImages || []).length, afterNoiseFilter: 0, afterDedupe: 0, dropped: [], stage: 'recognize' };
        const normalized = normalizeUrls(rawImages);
        diag.afterNoiseFilter = normalized.length;
        const { uniq, dropped } = await dedupeByContent(normalized, opts.fingerprint);
        diag.afterDedupe = uniq.length;
        diag.dropped = dropped.map(d => ({ url: d.url, dupOf: d.dupOf }));
        try {
            const mapped = mapToOutputs(uniq, outputKeys, expectCount);
            return { ok: true, results: mapped, diag };
        } catch (e) {
            diag.stage = 'map';
            diag.error = e.message;
            return { ok: false, error: e.message, diag };
        }
    }

    /* ---------------- 2) 写盘 + 重新读取校验 ---------------- */

    // deps: { decodeSize(blob) -> {width,height} } 由调用方注入（浏览器 createImageBitmap）
    async function writeAndVerify(dirHandle, filename, blob, deps = {}) {
        if (!dirHandle) return { ok: false, error: '没有已授权的目录句柄' };
        if (!blob || !blob.size) return { ok: false, error: '内容为空，未写入' };
        try {
            const w = await dirHandle.getFileHandle(filename, { create: true });
            const stream = await w.createWritable();
            await stream.write(blob);
            await stream.close();                       // 必须关闭写入流后再回读

            const fh = await dirHandle.getFileHandle(filename);
            const f = await fh.getFile();
            if (!f || !f.size) return { ok: false, error: '回读文件为空' };
            if (f.size !== blob.size) return { ok: false, error: `回读大小不一致（${f.size} ≠ ${blob.size}）` };
            if (!/^image\//i.test(f.type || '')) return { ok: false, error: `回读类型不是图片（${f.type || '未知'}）` };
            let size = null;
            if (typeof deps.decodeSize === 'function') {
                size = await deps.decodeSize(f);
                if (!size || !(size.width >= 64 && size.height >= 64)) {
                    return { ok: false, error: `回读解码尺寸无效（${size ? size.width + '×' + size.height : '无法解码'}）` };
                }
            }
            return { ok: true, bytes: f.size, type: f.type, width: size && size.width, height: size && size.height, filename };
        } catch (e) {
            return { ok: false, error: '写入/校验失败：' + (e && e.message) };
        }
    }

    // 文件名：按源表标识 + 行号 + 编号归档，避免跨文件/跨产品覆盖
    function buildFilename(fileKey, rowNum, outputKey, ext = 'png') {
        const fk = (fileKey === undefined || fileKey === null) ? '' : String(fileKey);
        const safeKey = fk.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_') || 'default';
        return `suite_${safeKey}_row${rowNum}_${outputKey}.${ext}`;
    }

    /* 六项能力之"写盘校验"的整套编排：
       逐张写入并校验；全部成功才 saved；任一失败保留已获取结果，可只重试保存 */
    async function saveAll(dirHandle, items, deps = {}) {
        const results = [];
        for (const it of items) {
            const filename = deps.buildFilename
                ? deps.buildFilename(it)
                : buildFilename(deps.fileKey, deps.rowNum, it.key, deps.ext || 'png');
            const r = await writeAndVerify(dirHandle, filename, it.blob, deps);
            results.push({ key: it.key, filename, saved: !!r.ok, bytes: r.bytes || 0, width: r.width, height: r.height, error: r.error || '' });
        }
        const allSaved = results.length > 0 && results.every(r => r.saved);
        return {
            ok: allSaved, results,
            savedCount: results.filter(r => r.saved).length,
            failedKeys: results.filter(r => !r.saved).map(r => r.key),
            // 写盘失败时：结果已获取，恢复时优先重试保存（不重新消耗豆包额度）
            retrySaveOnly: !allSaved
        };
    }

    /* ---------------- 3) 结果持久化（IndexedDB） ---------------- */

    function ResultStore(dbName = 'polo_suite_results', storeName = 'results') {
        function open() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(dbName, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(storeName)) {
                        const os = db.createObjectStore(storeName, { keyPath: 'id' });
                        os.createIndex('byTarget', ['fileKey', 'rowNum'], { unique: false });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        const idOf = (fileKey, rowNum, key) => `${(fileKey === undefined || fileKey === null) ? '' : fileKey}::${rowNum}::${key}`;

        async function put({ fileKey, rowNum, key, taskId, blob, meta }) {
            const db = await open();
            const rec = {
                id: idOf(fileKey, rowNum, key),
                fileKey: (fileKey === undefined || fileKey === null) ? '' : fileKey,
                rowNum, key, taskId: taskId || null,
                blob: blob || null,
                meta: meta || {},
                savedAt: Date.now()
            };
            await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).put(rec);
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
            });
            return rec;
        }

        async function get(fileKey, rowNum, key) {
            const db = await open();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readonly');
                const r = tx.objectStore(storeName).get(idOf(fileKey, rowNum, key));
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
        }

        // 只返回该 fileKey + rowNum 的记录（切换产品不混图）
        async function list(fileKey, rowNum) {
            const db = await open();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readonly');
                const idx = tx.objectStore(storeName).index('byTarget');
                const r = idx.getAll([(fileKey === undefined || fileKey === null) ? '' : fileKey, rowNum]);
                r.onsuccess = () => resolve(r.result || []);
                r.onerror = () => reject(r.error);
            });
        }

        async function remove(fileKey, rowNum, key) {
            const db = await open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).delete(idOf(fileKey, rowNum, key));
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
            });
        }

        return { open, put, get, list, remove, idOf };
    }

    return {
        REQUIRED_COLORS, DEFAULT_EXPECT,
        normalizeUrls, dedupeByContent, mapToOutputs, recognize,
        writeAndVerify, buildFilename, saveAll,
        ResultStore
    };
})();

if (typeof globalThis !== 'undefined') globalThis.SuiteCore = SuiteCore;
