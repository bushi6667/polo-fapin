/* 路径配置 —— 网页是路径配置的唯一来源。
 *
 * 设计约束（对应验收要求）：
 *   1. 配置存在 localStorage（页面侧真源），同时同步给本地服务做读取白名单；
 *   2. 显示与保存一律使用完整绝对路径，绝不显示文件夹短名；
 *   3. `polo-dir:*` 句柄令牌不是路径，保存时判为不可用，要求填写完整路径；
 *   4. 所有本地文件读写经 http://127.0.0.1:8765，不用 fetch('file://…')；
 *   5. 服务未启动时明确提示，不回退 file://、不显示旧缓存。
 *
 * 暴露：window.PathConfig { open, close, read, save, status, imageUrl, colorImagePath, serverUp, FIELDS }
 */
(() => {
    'use strict';

    const STORAGE_KEY = 'polo_path_config_v1';
    const SERVER = 'http://127.0.0.1:8765';

    const FIELDS = [
        { key: 'colorImgDir', label: '产品套图目录', hint: '颜色图与套图成品（<文件名>/rowN/row1_white.png 等）' },
        { key: 'imageDir', label: '产品原图目录', hint: '产品主图来源目录' },
        { key: 'scriptDir', label: 'JS 脚本目录', hint: '后处理脚本所在目录' },
        { key: 'suiteDir', label: '套图输出目录', hint: '留空则与产品套图目录一致' }
    ];

    const KEY_BY_FIELD = FIELDS.reduce((m, f) => { m[f.key] = f.label; return m; }, {});
    const STATUS_TEXT = {
        unset: '未配置',
        ok: '可用',
        missing: '目录不存在',
        'not-absolute': '不是绝对路径',
        invalid: '需要填写完整路径',
        'server-down': '本地服务未启动'
    };

    let state = null;          // { panel, original, view, scroll }
    let serverState = 'unknown'; // 'up' | 'down' | 'unknown'

    function normalizePath(v) {
        const s = String(v === undefined || v === null ? '' : v).trim();
        if (!s) return '';
        // 只去掉末尾多余分隔符，不改盘符、中文、空格、连字符
        return s.replace(/[\\/]+$/, '');
    }

    function read() {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (_) { saved = {}; }
        const out = {};
        for (const f of FIELDS) out[f.key] = normalizePath(saved[f.key]);
        return out;
    }

    function writeLocal(cfg) {
        const out = {};
        for (const f of FIELDS) out[f.key] = normalizePath(cfg[f.key]);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
        return out;
    }

    function serverUp() { return serverState === 'up'; }

    async function pingServer() {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 1500);
            const r = await fetch(SERVER + '/path-config', { signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(timer);
            serverState = r.ok ? 'up' : 'down';
        } catch (_) { serverState = 'down'; }
        return serverState;
    }

    // 本地服务读取本地图片的唯一入口：绝对路径 → 服务端校验白名单后返回二进制
    function imageUrl(absPath, bust) {
        const q = SERVER + '/local-image?path=' + encodeURIComponent(normalizePath(absPath));
        return bust ? q + '&v=' + Date.now() : q;
    }

    // 颜色图绝对路径：<产品套图目录>/<当前Excel对应目录>/rowN/rowN_<color>.png
    function colorImagePath(rowNum, color, fileFolder) {
        const base = read().colorImgDir;
        if (!base || !fileFolder) return '';
        const sep = /\\/.test(base) && !/\//.test(base) ? '\\' : '/';
        return normalizePath(base) + sep + fileFolder + sep + 'row' + rowNum + sep + 'row' + rowNum + '_' + color + '.png';
    }

    function chip(text, kind) {
        const span = document.createElement('span');
        span.className = 'path-chip path-chip-' + (kind || 'unset');
        span.textContent = text;
        return span;
    }

    function statusKind(status) {
        if (status === 'ok') return 'ok';
        if (status === 'unset') return 'unset';
        return 'bad';
    }

    async function saveFromInputs(view) {
        const cfg = {};
        view.querySelectorAll('[data-path-key]').forEach(input => {
            cfg[input.dataset.pathKey] = normalizePath(input.value);
        });
        const message = view.querySelector('.path-config-message');
        // 句柄令牌不是路径，明确拒绝而不是存下来当路径用
        const badToken = Object.keys(cfg).find(k => /^polo-dir:/.test(cfg[k]));
        if (badToken) {
            message.textContent = '「' + KEY_BY_FIELD[badToken] + '」是旧的目录句柄令牌，不是路径，请填写完整绝对路径（例如 C:\\Users\\你\\Downloads\\Polo发品_颜色图）';
            message.className = 'path-config-message is-error';
            return;
        }
        writeLocal(cfg);
        await pingServer();
        if (!serverUp()) {
            renderStatuses(view, cfg, 'server-down');
            message.textContent = '已保存到页面，但本地服务未启动：启动方式在项目目录执行 node _server.js，然后回来点「刷新状态」。';
            message.className = 'path-config-message is-error';
            return;
        }
        let items = [];
        try {
            const r = await fetch(SERVER + '/path-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            });
            const data = await r.json();
            if (!data || !data.ok) throw new Error((data && data.error) || '保存失败');
            items = data.items || [];
            writeLocal(data.config || cfg);
        } catch (e) {
            message.textContent = '保存到本地服务失败：' + (e && e.message ? e.message : e);
            message.className = 'path-config-message is-error';
            return;
        }
        renderStatuses(view, read(), null, items);
        const bad = items.filter(it => it.status === 'missing' || it.status === 'not-absolute' || it.status === 'invalid');
        message.textContent = bad.length
            ? '已保存，但有 ' + bad.length + ' 项不可用：' + bad.map(it => KEY_BY_FIELD[it.key] + '（' + STATUS_TEXT[it.status] + '）').join('、')
            : '已保存，路径全部可用。';
        message.className = 'path-config-message' + (bad.length ? ' is-error' : ' is-ok');
        if (typeof window.loadColorImagesFromExtension === 'function' && window.currentProduct) {
            window.loadColorImagesFromExtension(window.currentProduct.row);
        }
    }

    function renderStatuses(view, cfg, overrideStatus, items) {
        const byKey = {};
        (items || []).forEach(it => { byKey[it.key] = it.status; });
        view.querySelectorAll('[data-path-key]').forEach(input => {
            const key = input.dataset.pathKey;
            const holder = view.querySelector('[data-status-for="' + key + '"]');
            if (!holder) return;
            let status = overrideStatus || byKey[key];
            if (!status) status = cfg[key] ? (serverUp() ? 'unknown' : 'server-down') : 'unset';
            holder.innerHTML = '';
            holder.appendChild(chip(STATUS_TEXT[status] || status, statusKind(status)));
            holder.title = cfg[key] || '';
        });
    }

    function buildView() {
        const view = document.createElement('div');
        view.className = 'step-config-view path-config-view';
        view.innerHTML = `<header class="step-config-heading"><h2>📁 路径配置</h2>
                <button class="step-close" data-command="close" aria-label="退出路径配置">×</button></header>
            <div class="step-config-toolbar"><p>所有路径都用完整绝对路径，末尾斜杠自动去掉；本地文件由本地服务（127.0.0.1:8765）读写，不再依赖浏览器目录授权。</p></div>
            <div class="path-config-list"></div>
            <div class="path-config-message" role="status"></div>
            <footer class="step-config-footer"><button data-command="close">关闭</button>
                <button data-command="refresh">刷新状态</button>
                <button class="primary" data-command="save">保存</button></footer>`;
        const list = view.querySelector('.path-config-list');
        const cfg = read();
        list.innerHTML = FIELDS.map(f => `<div class="path-config-row">
                <div class="path-config-meta"><b>${f.label}</b><span>${f.hint}</span></div>
                <input type="text" data-path-key="${f.key}" value="${(cfg[f.key] || '').replace(/"/g, '&quot;')}"
                    placeholder="${f.key === 'colorImgDir' ? 'C:\\Users\\你\\Downloads\\Polo发品_颜色图' : '完整绝对路径'}" spellcheck="false">
                <div class="path-config-status" data-status-for="${f.key}"></div>
            </div>`).join('');
        return view;
    }

    async function open() {
        if (state) return;
        const panel = document.getElementById('detailPanel');
        if (!panel) return;
        const original = document.createDocumentFragment();
        while (panel.firstChild) original.appendChild(panel.firstChild);
        state = { panel, original, scroll: panel.scrollTop };
        const view = buildView();
        state.view = view;
        panel.classList.add('step-config-mode');
        panel.appendChild(view);
        window.UiPolish && window.UiPolish.enter && window.UiPolish.enter(view);
        view.addEventListener('click', (e) => {
            const cmd = e.target && e.target.dataset ? e.target.dataset.command : '';
            if (cmd === 'close') close();
            else if (cmd === 'save') saveFromInputs(view);
            else if (cmd === 'refresh') refreshStatuses(view);
        });
        await refreshStatuses(view);
    }

    async function refreshStatuses(view) {
        const cfg = read();
        const message = view && view.querySelector('.path-config-message');
        await pingServer();
        if (!serverUp()) {
            if (view) renderStatuses(view, cfg, 'server-down');
            if (message) {
                message.textContent = '本地服务未启动：在该项目目录执行 node _server.js（默认 http://127.0.0.1:8765），启动后点「刷新状态」。';
                message.className = 'path-config-message is-error';
            }
            return;
        }
        let items = [];
        try {
            const r = await fetch(SERVER + '/path-config', { cache: 'no-store' });
            const data = await r.json();
            items = (data && data.items) || [];
            if (data && data.config) {
                // 页面为空而服务端有值 → 用服务端补齐（不覆盖页面已有值）
                const merged = { ...data.config };
                for (const f of FIELDS) if (cfg[f.key]) merged[f.key] = cfg[f.key];
                writeLocal(merged);
            }
        } catch (_) {}
        if (view) {
            // 刷新只读：绝不在这里 POST，否则会用（可能为空的）页面值覆盖服务端白名单
            renderStatuses(view, read(), null, items);
            if (message && !message.textContent) {
                message.textContent = '本地服务已连接。';
                message.className = 'path-config-message is-ok';
            }
        }
    }

    function close() {
        if (!state) return;
        const { panel, original, scroll } = state;
        state = null;
        panel.classList.remove('step-config-mode');
        panel.innerHTML = '';
        panel.appendChild(original);
        panel.scrollTop = scroll || 0;
    }

    // 首次加载：页面为空时从扩展迁移旧绝对路径（不覆盖页面已有值，不迁移 polo-dir 令牌）
    async function migrateFromExtensionOnce() {
        const cfg = read();
        if (cfg.colorImgDir) return;
        try {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
            const extId = (typeof EXTENSION_ID === 'string' && EXTENSION_ID) || localStorage.getItem('polo_extension_id') || '';
            if (!extId) return;
            const resp = await new Promise(resolve => {
                try {
                    chrome.runtime.sendMessage(extId, { action: 'getConfig' }, r => {
                        if (chrome.runtime.lastError) resolve(null); else resolve(r);
                    });
                } catch (_) { resolve(null); }
            });
            const dir = resp && resp.config && resp.config.colorImgDir;
            if (!dir || /^polo-dir:/.test(dir) || !/^[A-Za-z]:[\\/]|^\\\\/.test(dir)) return;
            const merged = { ...cfg, colorImgDir: dir };
            writeLocal(merged);
            // 迁移后立即同步服务端白名单，否则首次读图会 403；页面已有值不参与迁移，不会被覆盖
            try {
                await fetch(SERVER + '/path-config', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged)
                });
            } catch (_) {}
        } catch (_) {}
    }

    window.PathConfig = {
        FIELDS, open, close, read, imageUrl, colorImagePath, serverUp,
        serverState: () => serverState,
        saveAll: (cfg) => writeLocal(cfg),
        pingServer,
        migrateFromExtensionOnce
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', migrateFromExtensionOnce);
    } else {
        migrateFromExtensionOnce();
    }
})();
