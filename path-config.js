/* 路径配置 —— 页面自己保存完整绝对路径，读取本地图片用 file:// 直读。
 *
 * 关键点（不需要任何本地服务、不需要目录授权）：
 *   1. 配置存 localStorage：切产品 / 重导 Excel / 刷新 / 重启浏览器都不丢；
 *   2. 全流程只用完整绝对路径，绝不显示文件夹短名；
 *   3. `polo-dir:*` 是旧句柄令牌，不是路径，保存时判为不可用；
 *   4. 图片由浏览器按 file:// 直读（页面本身是 file:// 时可用），删文件即消失。
 *
 * 暴露：window.PathConfig { open, close, read, saveAll, colorImagePath, toFileUrl, FIELDS }
 */
(() => {
    'use strict';

    const STORAGE_KEY = 'polo_path_config_v1';

    const FIELDS = [
        { key: 'colorImgDir', label: '产品图片目录', hint: '统一保存颜色图与套图成品（<Excel文件名>/rowN/）' },
        { key: 'imageDir', label: '产品原图目录', hint: '产品主图来源目录' },
        { key: 'scriptDir', label: 'JS 脚本目录', hint: '后处理脚本所在目录' }
    ];

    const KEY_BY_FIELD = FIELDS.reduce((m, f) => { m[f.key] = f.label; return m; }, {});
    const STATUS_TEXT = {
        unset: '未配置',
        ok: '已配置（完整路径）',
        'not-absolute': '需要完整绝对路径',
        invalid: '这是旧句柄记录，请填完整路径'
    };

    let state = null;

    function normalizePath(v) {
        const s = String(v === undefined || v === null ? '' : v).trim();
        if (!s) return '';
        return s.replace(/[\\/]+$/, '');   // 只去掉末尾分隔符，不改盘符/中文/空格/连字符
    }

    function isAbsolutePath(v) {
        return /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v);
    }

    function statusOf(v) {
        const p = normalizePath(v);
        if (!p) return 'unset';
        if (/^polo-dir:/.test(p)) return 'invalid';
        if (!isAbsolutePath(p)) return 'not-absolute';
        return 'ok';
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

    // 颜色图绝对路径：<产品套图目录>/<当前Excel对应目录>/rowN/rowN_<color>.png
    function colorImagePath(rowNum, color, fileFolder) {
        const base = read().colorImgDir;
        if (!base || !fileFolder) return '';
        const sep = /^[A-Za-z]:\\/.test(base) ? '\\' : '/';
        return normalizePath(base) + sep + fileFolder + sep + 'row' + rowNum + sep + 'row' + rowNum + '_' + color + '.png';
    }

    // 绝对路径 → file:// URL，带时间戳强制回源（删文件立刻反映）
    function toFileUrl(absPath) {
        const p = String(absPath || '').split(String.fromCharCode(92)).join('/');
        const url = p.startsWith('/') ? 'file://' + p : 'file:///' + p;
        return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
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

    function renderStatuses(view) {
        const cfg = read();
        view.querySelectorAll('[data-path-key]').forEach(input => {
            const key = input.dataset.pathKey;
            const holder = view.querySelector('[data-status-for="' + key + '"]');
            if (!holder) return;
            // 输入框有改动时按输入值即时判定
            const value = input.value && input.value !== cfg[key] ? input.value : cfg[key];
            const selected = window.PageDirectories?.handles[key] || (key==='suiteDir'&&window.PageDirectories?.handles.colorImgDir);
            const st = selected ? 'ok' : 'unset';
            holder.innerHTML = '';
            holder.appendChild(chip(selected ? '已选择（权限另行检查）' : '请点击选择目录', statusKind(st)));
            holder.title = normalizePath(value) || '';
        });
    }

    function saveFromInputs(view) {
        window.PageDirectories.permissions().then(permissions=>{
            if(permissions.some(p=>p!=='granted'))throw Error('部分目录尚未授权，请重新选择对应目录或确认浏览器权限');
            const cfg={};view.querySelectorAll('[data-path-key]').forEach(input=>{cfg[input.dataset.pathKey]=input.value;});
            writeLocal(cfg);renderStatuses(view);
            view.querySelector('.path-config-message').textContent='目录选择已记住；生成、预览和上传统一使用本页选择的目录。';
            if(typeof currentProduct!=='undefined'&&currentProduct)loadColorImagesFromExtension(currentProduct.row);
        }).catch(e=>{view.querySelector('.path-config-message').textContent=e.message;});
        return;
        const cfg = {};
        view.querySelectorAll('[data-path-key]').forEach(input => {
            cfg[input.dataset.pathKey] = normalizePath(input.value);
        });
        const message = view.querySelector('.path-config-message');
        // 旧句柄令牌不是路径：明确拒绝，不能存下来当路径用
        const badToken = Object.keys(cfg).find(k => /^polo-dir:/.test(cfg[k]));
        if (badToken) {
            message.textContent = '「' + KEY_BY_FIELD[badToken] + '」是旧的目录句柄记录，不是路径。请填写完整绝对路径，例如 C:\\Users\\你\\Downloads\\Polo发品_颜色图';
            message.className = 'path-config-message is-error';
            return;
        }
        const saved = writeLocal(cfg);
        renderStatuses(view);
        const bad = Object.keys(saved).filter(k => saved[k] && statusOf(saved[k]) !== 'ok');
        message.textContent = bad.length
            ? '已保存，但有 ' + bad.length + ' 项不是完整绝对路径：' + bad.map(k => KEY_BY_FIELD[k]).join('、')
            : '已保存，刷新后仍然有效。';
        message.className = 'path-config-message' + (bad.length ? ' is-error' : ' is-ok');
        if (typeof window.loadColorImagesFromExtension === 'function' && window.currentProduct) {
            window.loadColorImagesFromExtension(window.currentProduct.row);
        }
    }

    function buildView() {
        const view = document.createElement('div');
        view.className = 'step-config-view path-config-view';
        view.innerHTML = `<header class="step-config-heading"><h2>📁 路径配置</h2>
                <button class="step-close" data-command="close" aria-label="退出路径配置">×</button></header>
            <div class="step-config-toolbar"><p>目录统一在本页选择，扩展不再单独配置。首次迁移请逐项选择实际文件夹，刷新后保留；需要时点击保存确认授权。浏览器仅返回目录名称，不提供完整地址。</p></div>
            <div class="path-config-list"></div>
            <div class="path-config-message" role="status"></div>
            <footer class="step-config-footer"><button data-command="close">关闭</button>
                <button class="primary" data-command="save">保存</button></footer>`;
        const list = view.querySelector('.path-config-list');
        const cfg = read();
        list.innerHTML = FIELDS.map(f => `<div class="path-config-row">
                <div class="path-config-meta"><b>${f.label}</b><span>${f.hint}</span></div>
                <input type="text" data-path-key="${f.key}" value="${(cfg[f.key] || '').replace(/"/g, '&quot;')}"
                    placeholder="${f.key === 'colorImgDir' ? 'C:\\Users\\你\\Downloads\\Polo发品_颜色图' : '完整绝对路径'}" spellcheck="false">
                <div class="path-config-status" data-status-for="${f.key}"></div>
                <button type="button" data-choose-directory="${f.key}">选择目录</button>
            </div>`).join('');
        return view;
    }

    function open() {
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
            const key=e.target?.dataset?.chooseDirectory;
            if(key){window.PageDirectories.choose(key).then(record=>{
                view.querySelector('[data-path-key="'+key+'"]').value=record.name;
                const cfg=read();cfg[key]=record.name;writeLocal(cfg);renderStatuses(view);
            }).catch(error=>{if(error.name!=='AbortError')view.querySelector('.path-config-message').textContent=error.message;});return;}
            const cmd = e.target && e.target.dataset ? e.target.dataset.command : '';
            if (cmd === 'close') close();
            else if (cmd === 'save') saveFromInputs(view);
        });
        view.addEventListener('input', () => renderStatuses(view));
        view.querySelectorAll('[data-path-key]').forEach(input=>{input.readOnly=true;});
        window.PageDirectories.ready.then(()=>{
            view.querySelectorAll('[data-path-key]').forEach(input=>{const r=window.PageDirectories.records[input.dataset.pathKey];if(r)input.value=r.name;});renderStatuses(view);
        });
        renderStatuses(view);
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

    // 首次加载：页面为空时，从扩展里已保存的完整绝对路径迁移过来（不迁移 polo-dir 令牌、不覆盖页面已有值）
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
            if (!dir || !isAbsolutePath(normalizePath(dir))) return;
            writeLocal({ ...cfg, colorImgDir: normalizePath(dir) });
        } catch (_) {}
    }

    window.PathConfig = {
        FIELDS, open, close, read, saveAll: writeLocal, colorImagePath, toFileUrl,
        normalizePath, statusOf, isAbsolutePath, migrateFromExtensionOnce
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', migrateFromExtensionOnce);
    else migrateFromExtensionOnce();
})();
