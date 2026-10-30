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
    const BACKUP_DIR = '归档/update-backup';

    function db() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbGet() {
        const d = await db();
        try {
            return await new Promise((resolve, reject) => {
                const tx = d.transaction(STORE, 'readonly');
                const r = tx.objectStore(STORE).get(KEY);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
        } finally { d.close(); }
    }

    async function idbSet(value) {
        const d = await db();
        try {
            await new Promise((resolve, reject) => {
                const tx = d.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(value, KEY);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } finally { d.close(); }
    }

    async function getDir() {
        const rec = await idbGet();
        if (!rec || !rec.handle) return null;
        const h = rec.handle;
        const perm = await h.queryPermission({ mode: 'readwrite' });
        return { handle: h, name: rec.name || h.name, granted: perm === 'granted' };
    }

    // 必须在点击手势内调用
    async function pickDir() {
        const handle = await window.showDirectoryPicker({ id: 'polo-project', mode: 'readwrite' });
        await idbSet({ handle, name: handle.name, at: Date.now() });
        return { handle, name: handle.name, granted: true };
    }

    async function requestPerm() {
        const cur = await getDir();
        if (!cur) return null;
        const perm = await cur.handle.requestPermission({ mode: 'readwrite' });
        return { ...cur, granted: perm === 'granted' };
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
        try {
            const r = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
            if (!r.ok) throw Error('HTTP ' + r.status);
            return await r.json();
        } catch (_) {
            const r = await viaExtension({ action: 'updaterFetch', url, json: true });
            return JSON.parse(r.text);
        }
    }

    async function getBytes(url) {
        try {
            const r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) throw Error('HTTP ' + r.status);
            return new Uint8Array(await r.arrayBuffer());
        } catch (_) {
            const r = await viaExtension({ action: 'updaterFetch', url, json: false });
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
        return {
            localBuild: local,
            remote,
            hasUpdate: isFinite(lt) && isFinite(rt) && rt > lt,
        };
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
        if (!cur || !cur.granted) throw Error('还没有授权项目目录（首次需要选一次）');
        const root = cur.handle;

        report({ phase: 'check' });
        const info = await check();
        if (!info.hasUpdate) return { updated: false, sha: info.remote.sha, written: 0, failed: [] };

        const sha = info.remote.sha;
        report({ phase: 'tree' });
        const nodes = await fileTree(sha);
        const total = nodes.length;
        report({ phase: 'download', done: 0, total });

        const ts = stamp();
        const written = [], failed = [];
        let done = 0;

        for (const node of nodes) {
            const path = node.path;
            const parts = path.split('/');
            const name = parts.pop();
            try {
                const bytes = await downloadFile(sha, path);

                // 备份旧文件，写失败还能找回
                const old = await readExisting(root, parts, name);
                if (old) {
                    await writeFile(root, [BACKUP_DIR, ts, ...parts], name, old);
                }

                await writeFile(root, parts, name, bytes);
                written.push(path);
            } catch (e) {
                failed.push(path + '：' + ((e && e.message) || e));
            }
            done++;
            report({ phase: 'download', done, total, path, failed: failed.length });
        }

        report({ phase: 'done', done, total, written: written.length, failed });
        return { updated: true, sha, written: written.length, failed, backup: BACKUP_DIR + '/' + ts };
    }

    window.PoloUpdater = { getDir, pickDir, requestPerm, check, apply, localBuild, REPO, BRANCH };
})();
