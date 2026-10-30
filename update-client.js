/*
 * 项目自更新客户端（零外部程序）
 *
 * 流程：
 *   1. 页面授权一次项目根目录（File System Access API，句柄存 IndexedDB）
 *   2. api.github.com 取最新提交 sha + 文件清单（1 次请求，避开 60/h 限制）
 *   3. 逐个文件从 cdn.jsdelivr.net 下载（支持跨域、无速率限制）
 *   4. 备份被覆盖的文件 → 写入项目目录
 *   5. 由页面通知扩展重载 + 自身刷新
 *
 * 只覆盖代码文件；xlsx / 图片目录 / 归档 / tests 一律不碰。
 */
(() => {
    'use strict';

    const REPO = 'bushi6667/polo-fapin';
    const BRANCH = 'fix/group-select-double-click';
    const DB_NAME = 'PoloUpdater';
    const STORE = 'h';
    const KEY = 'projectDir';
    const BACKUP_PARTS = ['归档', 'update-backup'];   // 目录 API 不接受带 / 的名字，必须拆段

    // 目录句柄统一由 PageDirectories 管理（路径配置里选择），这里只取用
    async function pdReady() {
        const pd = window.PageDirectories;
        if (!pd) return null;
        try { await pd.ready; } catch (_) {}
        return pd;
    }

    async function getDir() {
        const pd = await pdReady();
        const h = pd && pd.handles && pd.handles.projectDir;
        if (!h) return null;
        let perm = 'prompt';
        try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (_) {}
        const rec = pd.records && pd.records.projectDir;
        return { handle: h, name: (rec && rec.name) || h.name, granted: perm === 'granted' };
    }

    // 必须在点击手势内调用；优先走路径配置的同一入口
    async function pickDir() {
        const pd = await pdReady();
        if (!pd) throw Error('目录模块未加载');
        const rec = await pd.choose('projectDir');
        return { handle: rec.handle, name: rec.name, granted: true };
    }

    async function requestPerm() {
        const cur = await getDir();
        if (!cur) return null;
        let perm = 'prompt';
        try { perm = await cur.handle.requestPermission({ mode: 'readwrite' }); } catch (_) {}
        return { ...cur, granted: perm === 'granted' };
    }


    // 任何网络请求都不能无限等：页面直连常被墙/挂起，表现为"一直不返回"
    function timeout(ms, label) {
        let timer;
        const p = new Promise((_, reject) => { timer = setTimeout(() => reject(Error((label || '请求') + '超时')), ms); });
        return { promise: p, clear: () => clearTimeout(timer) };
    }

    async function withTimeout(promise, ms, label) {
        const t = timeout(ms, label);
        try { return await Promise.race([promise, t.promise]); }
        finally { t.clear(); }
    }

    // ---- 网络：页面直连优先，失败改走扩展后台（绕过 CORS，可重试）----
    function extId() {
        try { return localStorage.getItem('polo_extension_id') || ''; } catch (_) { return ''; }
    }

    function viaExtension(payload) {
        return new Promise((resolve, reject) => {
            const id = extId();
            if (!id) return reject(Error('未配置扩展 ID'));
            try {
                chrome.runtime.sendMessage(id, payload, resp => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(Error(err.message));
                    if (!resp) return reject(Error('扩展未回复'));
                    if (!resp.ok) return reject(Error(resp.error || '取回失败'));
                    resolve(resp);
                });
            } catch (e) { reject(e); }
        });
    }

    async function getJson(url) {
        // 网络对 api.github.com 时通时断，直连先重试 3 次再改走扩展
        let lastErr = '';
        for (let i = 0; i < 3; i++) {
            try {
                const r = await withTimeout(fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } }), 8000, '直连');
                if (!r.ok) { lastErr = 'HTTP ' + r.status; }
                else return await r.json();
            } catch (e) { lastErr = String((e && e.message) || e); }
            await new Promise(r2 => setTimeout(r2, 800));
        }
        try {
            const r = await withTimeout(viaExtension({ action: 'updaterFetch', url, json: true }), 20000, '扩展代取');
            return JSON.parse(r.text);
        } catch (e) {
            throw Error(lastErr || String((e && e.message) || e));
        }
    }

    async function getBytes(url) {
        try {
            const r = await withTimeout(fetch(url, { cache: 'no-store' }), 8000, '直连');
            if (!r.ok) throw Error('HTTP ' + r.status);
            return new Uint8Array(await r.arrayBuffer());
        } catch (_) {
            const r = await withTimeout(viaExtension({ action: 'updaterFetch', url, json: false }), 30000, '扩展代取');
            const bin = atob(r.base64 || '');
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
    }

    function localBuild() {
        const meta = document.querySelector('meta[name="polo-build"]');
        return meta ? meta.getAttribute('content') : '';
    }

    async function remoteCommit() {
        const url = 'https://api.github.com/repos/' + REPO + '/commits/' + BRANCH;
        const j = await getJson(url);
        return {
            sha: j.sha,
            date: (j.commit && j.commit.committer && j.commit.committer.date) || '',
            message: ((j.commit && j.commit.message) || '').split(String.fromCharCode(10))[0],
        };
    }

    async function check() {
        const local = localBuild();
        const remote = await remoteCommit();
        const lt = Date.parse(local);
        const rt = Date.parse(remote.date);
        // 用「上次更新写入的 sha」优先判定：光比时间会在更新后仍显示有新版本，来回循环。
        let applied = '';
        try { applied = localStorage.getItem('polo_update_applied') || ''; } catch (_) {}
        const hasUpdate = applied
            ? (String(applied) !== String(remote.sha))
            : (isFinite(lt) && isFinite(rt) && (rt - lt) > 60 * 1000);
        return { localBuild: local, remote, appliedSha: applied, hasUpdate };
    }

    // 只更新这些文件；其余（表格、图片、归档、tests）一律跳过
    function keep(path) {
        if (!path) return false;
        if (/^(归档|tests|docs|提示词|项目素材|extracted_images|第42批图检查)\//.test(path)) return false;
        if (/\.xlsx?$/i.test(path)) return false;
        if (path === '发品助手.html' || path === 'version.json') return true;
        if (/^[^/]+\.(js|css)$/i.test(path)) return true;
        if (path.startsWith('chrome_extension/')) return true;
        return false;
    }

    // 整包下载：
    //   ① 扩展后台（快，但需要扩展已重载并带权限）
    //   ② 公共加速代理（页面可直接跨域下载，无需扩展）
    const MIRRORS = [
        sha => 'https://gh-proxy.com/https://github.com/' + REPO + '/archive/' + sha + '.zip',
        sha => 'https://ghproxy.net/https://github.com/' + REPO + '/archive/' + sha + '.zip',
    ];

    async function fetchZipViaExtension(sha) {
        await withTimeout(viaExtension({ action: 'updaterZip', sha }), 70000, '下载整包');
        const CHUNK = 1 << 20;
        const parts = [];
        let from = 0, done = false;
        while (!done) {
            const r = await withTimeout(viaExtension({ action: 'updaterZipChunk', sha, from, len: CHUNK }), 30000, '读取分块');
            if (!r.base64) break;
            const bin = atob(r.base64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            parts.push(arr);
            from += arr.length;
            done = !!r.done;
        }
        const total = parts.reduce((n, a) => n + a.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of parts) { out.set(a, off); off += a.length; }
        if (!out.length) throw Error('扩展没有返回内容');
        return out;
    }

    async function fetchZip(sha) {
        try { return await fetchZipViaExtension(sha); } catch (_) {}
        let lastErr = '';
        for (const make of MIRRORS) {
            const url = make(sha);
            try {
                const r = await withTimeout(fetch(url, { cache: 'no-store' }), 120000, '下载整包');
                if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
                const buf = new Uint8Array(await r.arrayBuffer());
                if (buf.length > 1000) return buf;
                lastErr = '返回内容为空';
            } catch (e) { lastErr = String((e && e.message) || e); }
        }
        throw Error('下载失败：' + (lastErr || '所有通道都不通'));
    }

    function u16(b, o) { return b[o] | (b[o + 1] << 8); }
    function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

    async function inflateRaw(bytes) {
        if (typeof DecompressionStream === 'undefined') throw Error('浏览器不支持解压');
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    // 解析 zip（中央目录），去掉 zipball 最外层目录那一层
    async function unzip(buf) {
        let eocd = -1;
        for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
            if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
        }
        if (eocd < 0) throw Error('不是有效的 zip');
        const count = u16(buf, eocd + 10);
        let p = u32(buf, eocd + 16);
        const out = [];
        for (let n = 0; n < count; n++) {
            if (u32(buf, p) !== 0x02014b50) break;
            const method = u16(buf, p + 10);
            const compSize = u32(buf, p + 20);
            const nameLen = u16(buf, p + 28);
            const extraLen = u16(buf, p + 30);
            const commentLen = u16(buf, p + 32);
            const localOff = u32(buf, p + 42);
            const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;
            if (name.endsWith('/')) continue;
            const lNameLen = u16(buf, localOff + 26);
            const lExtraLen = u16(buf, localOff + 28);
            const dataStart = localOff + 30 + lNameLen + lExtraLen;
            const raw = buf.subarray(dataStart, dataStart + compSize);
            let bytes;
            if (method === 0) bytes = raw;
            else if (method === 8) bytes = await inflateRaw(raw);
            else continue;
            const rel = name.split('/').slice(1).join('/');
            if (rel) out.push({ path: rel, bytes });
        }
        return out;
    }

    async function fileTree(sha) {
        const url = 'https://api.github.com/repos/' + REPO + '/git/trees/' + sha + '?recursive=1';
        const j = await getJson(url);
        return (j.tree || []).filter(n => n.type === 'blob' && keep(n.path));
    }

    async function downloadFile(sha, path) {
        const url = 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + sha + '/' + path.split('/').map(encodeURIComponent).join('/');
        return await getBytes(url);
    }

    async function ensureSubdir(root, parts) {
        let dir = root;
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
        return dir;
    }

    async function readExisting(root, parts, name) {
        try {
            const dir = await ensureSubdir(root, parts);
            const fh = await dir.getFileHandle(name, { create: false });
            const f = await fh.getFile();
            return new Uint8Array(await f.arrayBuffer());
        } catch (_) { return null; }
    }

    // 仓库里的文本是 LF，工作区是 CRLF（git core.autocrlf=true）；
    // 直接写 LF 会让所有文本文件在 git 里显示"已修改"（内容其实一样）。
    const TEXT_EXT = /\.(js|css|html?|json|md|txt|yml|yaml)$/i;
    function toCRLF(bytes, path) {
        if (!TEXT_EXT.test(path)) return bytes;
        let crlf = 0;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) crlf++;
        if (crlf === 0) return bytes;
        const out = new Uint8Array(bytes.length + crlf);
        let j = 0;
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if (b === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) { out[j++] = 0x0d; out[j++] = 0x0a; }
            else out[j++] = b;
        }
        return out.subarray(0, j);
    }

    async function writeFile(root, parts, name, bytes) {
        const dir = await ensureSubdir(root, parts);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
    }

    function stamp() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    /**
     * 下载并写入。onProgress({phase, done, total, path, failed})
     */
    async function apply(onProgress) {
        const report = (o) => { try { onProgress && onProgress(o); } catch (_) {} };
        const cur = await getDir();
        if (!cur || !cur.granted) throw Error('还没有授权项目目录（路径配置里选一次）');
        const root = cur.handle;

        // 防呆：必须是项目根目录（认 发品助手.html），否则会把整个仓库写进子目录
        // 真机踩过：路径配置里误选了 chrome_extension，结果整仓库被拷进扩展目录，扩展直接加载失败。
        if (String(root.name || '').toLowerCase() === 'chrome_extension') {
            throw Error('选中的是 chrome_extension 子目录，请改选项目根目录（含 发品助手.html 的那一层）');
        }
        let isProjectRoot = false;
        try { await root.getFileHandle('发品助手.html'); isProjectRoot = true; } catch (_) {}
        if (!isProjectRoot) {
            throw Error('选中的目录里没有 发品助手.html，不像项目根目录；请到「路径配置」重新选择项目根目录');
        }

        report({ phase: 'check' });
        const info = await check();
        if (!info.hasUpdate) return { updated: false, sha: info.remote.sha, written: 0, failed: [] };

        const sha = info.remote.sha;
        report({ phase: 'zip' });
        const zipBuf = await fetchZip(sha);
        const entries = (await unzip(zipBuf)).filter(e => keep(e.path));
        const total = entries.length;
        report({ phase: 'download', done: 0, total });

        const ts = stamp();
        const written = [], failed = [];
        let done = 0;
        let cursor = 0;

        // 6 路并发写盘（本地 IO，瓶颈在解压后的写入，不是网络）
        const worker = async () => {
            while (cursor < entries.length) {
                const node = entries[cursor++];
                const path = node.path;
                const parts = path.split('/');
                const name = parts.pop();
                try {
                    const bytes = node.bytes;

                    // 备份旧文件，写失败还能找回
                    const old = await readExisting(root, parts, name);
                    if (old) {
                        await writeFile(root, [...BACKUP_PARTS, ts, ...parts], name, old);
                    }

                    await writeFile(root, parts, name, toCRLF(bytes, path));
                    written.push(path);
                } catch (e) {
                    failed.push(path + '：' + ((e && e.message) || e));
                }
                done++;
                report({ phase: 'download', done, total, path, failed: failed.length });
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker));

        try { localStorage.setItem('polo_update_applied', sha); } catch (_) {}
        report({ phase: 'done', done, total, written: written.length, failed });
        return { updated: true, sha, written: written.length, failed, backup: BACKUP_PARTS.join('/') + '/' + ts };
    }

    window.PoloUpdater = { getDir, pickDir, requestPerm, check, apply, localBuild, REPO, BRANCH };
})();
