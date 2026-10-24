const STORAGE_KEY = 'polo_product_data';
// ============================================================
// popup.js —— 扩展弹窗逻辑
// 职责：显示/复制扩展 ID；首次使用向导；发品助手路径与颜色图目录配置
//       （含历史记录、跨机导入导出）；打开发品助手/发品页；粘贴数据
// 说明：配置存 chrome.storage.local，路径可填绝对路径或相对扩展根的相对路径
// ============================================================
const COLOR_IMG_DIR_KEY = 'polo_color_img_dir';
const HELPER_PATH_KEY = 'polo_helper_path';
const HELPER_PATH_HISTORY_KEY = 'polo_helper_path_history';
const COLOR_IMG_DIR_HISTORY_KEY = 'polo_color_img_dir_history';
const WIZARD_DISMISSED_KEY = 'polo_wizard_dismissed';
const HISTORY_MAX = 20;

// 配置导入导出涉及的 key（不含产品数据等大块业务数据，便于跨机迁移）
const CONFIG_EXPORT_KEYS = [
    HELPER_PATH_KEY,
    HELPER_PATH_HISTORY_KEY,
    COLOR_IMG_DIR_KEY,
    COLOR_IMG_DIR_HISTORY_KEY,
    'current_filename',
    'polo_image_dir',
    'polo_last_config'
];

let helperPath = '';

// ========== 扩展 ID 显示与复制 ==========

// 动态显示当前扩展 ID（chrome.runtime.id 在 popup 中可直接获取）
function initExtIdDisplay() {
    const id = chrome.runtime.id || '(未知)';
    const display = document.getElementById('ext-id-display');
    if (display) display.textContent = id;

    const copyBtn = document.getElementById('copy-ext-id');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(id);
                copyBtn.textContent = '已复制';
                setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
            } catch (e) {
                // clipboard API 在某些情况下被拒，回退到选中+execCommand
                const ta = document.createElement('textarea');
                ta.value = id;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); copyBtn.textContent = '已复制'; setTimeout(() => { copyBtn.textContent = '复制'; }, 1500); }
                catch (e2) { alert('复制失败，请手动选择 ID 文本复制：\n' + id); }
                document.body.removeChild(ta);
            }
        });
    }
}

// ========== 首次启动向导 ==========

// 检查是否需要显示向导：路径未配置且未被用户主动关闭过
function checkWizard() {
    chrome.storage.local.get([HELPER_PATH_KEY, WIZARD_DISMISSED_KEY], (result) => {
        const dismissed = result[WIZARD_DISMISSED_KEY];
        const hasPath = !!(result[HELPER_PATH_KEY] && result[HELPER_PATH_KEY].trim());
        const wizard = document.getElementById('wizard-box');
        if (!wizard) return;
        if (!dismissed && !hasPath) {
            wizard.style.display = 'block';
            updateWizardSteps(hasPath);
        } else {
            wizard.style.display = 'none';
        }
    });
}

function updateWizardSteps(hasPath) {
    const step1 = document.getElementById('step-helper-path');
    if (step1) step1.classList.toggle('wizard-step-done', !!hasPath);
}

document.getElementById('wizard-dismiss')?.addEventListener('click', () => {
    chrome.storage.local.set({ [WIZARD_DISMISSED_KEY]: true }, () => {
        document.getElementById('wizard-box').style.display = 'none';
    });
});

// ========== 历史下拉框 ==========

// 把值加入历史下拉记录（去重置顶，最多 HISTORY_MAX 条）
function addToHistory(historyKey, value) {
    if (!value) return Promise.resolve();
    return new Promise((resolve) => {
        chrome.storage.local.get(historyKey, (result) => {
            let list = result[historyKey] || [];
            list = list.filter(v => v !== value);
            list.unshift(value);
            if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
            chrome.storage.local.set({ [historyKey]: list }, () => resolve(list));
        });
    });
}

// 把历史记录渲染进指定下拉框（首项为占位文案）
function loadHistoryIntoSelect(selectId, historyKey) {
    chrome.storage.local.get([historyKey, 'polo_directory_labels'], (result) => {
        const list = result[historyKey] || [];
        const sel = document.getElementById(selectId);
        sel.innerHTML = '<option value="">曾经用过...</option>';
        for (const v of list) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = result.polo_directory_labels?.[v] || (selectId === 'color-img-dir-history' ? v.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : v);
            sel.appendChild(opt);
        }
    });
}

function loadHelperPath() {
    chrome.storage.local.get(HELPER_PATH_KEY, (result) => {
        if (result[HELPER_PATH_KEY]) {
            helperPath = result[HELPER_PATH_KEY];
            window.PoloSavedHelperPath = helperPath;
            document.getElementById('helper-path').value = decodeURIComponent(helperPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop());
        }
    });
}

loadHelperPath();
loadHistoryIntoSelect('helper-path-history', HELPER_PATH_HISTORY_KEY);
loadHistoryIntoSelect('color-img-dir-history', COLOR_IMG_DIR_HISTORY_KEY);

// 汇总当前配置写入 polo_last_config（供其他页面/发品助手读取）
function broadcastConfigChange() {
    chrome.storage.local.get([COLOR_IMG_DIR_KEY, HELPER_PATH_KEY], (result) => {
        const config = {
            colorImgDir: result[COLOR_IMG_DIR_KEY] || '',
            helperPath: result[HELPER_PATH_KEY] || ''
        };
        chrome.storage.local.set({ 'polo_last_config': config });
    });
}

// ========== 路径保存 ==========

// 解析路径：支持相对路径（相对扩展根目录），返回最终用于 chrome.tabs.create 的 file:/// URL
// 例如用户填 "./发品助手.html" 或 "发品助手.html"，会基于扩展根目录解析
// 通常用户应填绝对路径；相对路径仅在用户把扩展代码与 html 放在同目录时可用
function resolveHelperPath(raw) {
    if (!raw) return '';
    const trimmed = raw.trim();
    // 已是绝对路径（Windows 盘符 / Unix 根 / 已带 file://）
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('file://')) {
        return trimmed;
    }
    // 相对路径：基于扩展根目录解析（chrome.runtime.getURL 返回 chrome-extension://<id>/ 形式）
    // 注意：扩展是打包目录，html 文件不会在扩展内，所以相对路径只适用于把 html 复制进扩展目录的特殊情况
    // 大多数用户应填绝对路径
    try {
        return chrome.runtime.getURL(trimmed);
    } catch (e) {
        return trimmed;
    }
}

function pathToFileUrl(path) {
    // 绝对 Windows 路径转 file:/// URL（保留 drive letter）
    const resolved = resolveHelperPath(path);
    if (resolved.startsWith('file://') || resolved.startsWith('chrome-extension://')) {
        return resolved;
    }
    return 'file:///' + resolved.replace(/\\/g, '/').replace(/^\//, '');
}

document.getElementById('save-helper-path').addEventListener('click', async () => {
    if (window.PoloPathPickers?.['helper-path']?.validate() === false) return;
    let path;
    try {
    path = window.PoloPathPickers?.['helper-path']
        ? await window.PoloPathPickers['helper-path'].configurationValue()
        : document.getElementById('helper-path').value.trim();
    } catch(error) {alert(error.message);return;}
    chrome.storage.local.set({ [HELPER_PATH_KEY]: path }, async () => {
        helperPath = path;
        window.PoloSavedHelperPath = path;
        await window.PoloPathPickers?.['helper-path']?.committed();
        broadcastConfigChange();
        if (path) {
            await addToHistory(HELPER_PATH_HISTORY_KEY, path);
            loadHistoryIntoSelect('helper-path-history', HELPER_PATH_HISTORY_KEY);
            alert('✅ 发品助手路径已保存\n\n' + path);
        } else {
            alert('⚠️ 路径已清空');
        }
        checkWizard();
    });
});

document.getElementById('helper-path-history').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) {
        document.getElementById('helper-path').value = v;
        helperPath = v;
        broadcastConfigChange();
    }
});

async function saveExtensionColorDirectory(dir) {
    const result = await chrome.runtime.sendMessage({action:'updateConfig',config:{colorImgDir:dir}});
    if (!result?.ok) throw new Error(result?.error || '目录保存失败');
    broadcastConfigChange();
    if (dir) await addToHistory(COLOR_IMG_DIR_HISTORY_KEY,dir);
    loadHistoryIntoSelect('color-img-dir-history',COLOR_IMG_DIR_HISTORY_KEY);
}
document.getElementById('save-color-dir').addEventListener('click', async () => {
    if (window.PoloPathPickers?.['color-img-dir']?.validate() === false) return;
    try {
    // 输入框里直接是绝对路径时，以输入为准（避免选择器 pending 状态把路径顶成句柄令牌）
    const __input = document.getElementById('color-img-dir');
    const __typed = (__input && __input.value || '').trim();
    const __looksPath = /^[A-Za-z]:[\/]|^\\/.test(__typed);
    const dir = __looksPath
        ? __typed
        : (window.PoloPathPickers?.['color-img-dir']
            ? await window.PoloPathPickers['color-img-dir'].configurationValue()
            : __typed);
    // 统一路径模式：颜色图目录只接受绝对路径（纯字符串，永不失效、无需授权）。
    // 句柄令牌（polo-dir:）每次重载/重启都会退回 prompt，已废弃。
    if (typeof dir === 'string' && dir.startsWith('polo-dir:')) {
        alert('请改为填写文件夹绝对路径，例如 C:\\Users\\你\\Downloads\\Polo发品_颜色图。路径模式无需授权、不会失效，套图也写入同一目录。');
        return;
    }
    // 路径模式不需要任何权限：不再对历史句柄申请 readwrite（会把纯路径保存卡在授权弹窗）
    await saveExtensionColorDirectory(dir);await window.PoloPathPickers?.['color-img-dir']?.committed();alert(dir?'✅ 颜色图目录已保存':'目录已清空');}
    catch(e){alert('保存失败：'+e.message);}
});
document.getElementById('color-img-dir-history').addEventListener('change',async e=>{
    if(!e.target.value)return;
    const labels = await chrome.storage.local.get('polo_directory_labels');
    window.PoloSavedColorDir = e.target.value;
    document.getElementById('color-img-dir').value=labels.polo_directory_labels?.[e.target.value] || e.target.value.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    await window.PoloPathPickers?.['color-img-dir']?.useSaved(e.target.value);
    try{await saveExtensionColorDirectory(e.target.value);}catch(error){alert('保存失败：'+error.message);}
});

function loadColorImgDir() {
    chrome.storage.local.get([COLOR_IMG_DIR_KEY, 'polo_directory_labels'], (result) => {
        if (result[COLOR_IMG_DIR_KEY]) {
            window.PoloSavedColorDir = result[COLOR_IMG_DIR_KEY];
            document.getElementById('color-img-dir').value = result.polo_directory_labels?.[result[COLOR_IMG_DIR_KEY]] || result[COLOR_IMG_DIR_KEY].replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        }
    });
}

loadColorImgDir();

document.getElementById('open-helper').addEventListener('click', () => {
    if (!helperPath) {
        alert('请先设置发品助手.html的本地路径');
        return;
    }
    // 启动时传递当前扩展ID，助手记住后不再需要页面里的单独设置入口。
    const url = new URL(pathToFileUrl(helperPath));
    url.searchParams.set('poloExtension', chrome.runtime.id);
    chrome.tabs.create({ url: url.href });
});

document.getElementById('open-publish').addEventListener('click', () => {
    chrome.tabs.create({
        url: 'https://post.alibaba.com/product/easyListing.htm?spm=a2700.micro_product_manager.0.0.40e03e5fPaTwSu'
    });
});

document.getElementById('paste-data').addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        const data = JSON.parse(text);
        if (data && (data.title_en || data.seo_title_en)) {
            chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
                updateProductInfo(data);
            });
        } else {
            alert('剪贴板内容不是有效的产品数据');
        }
    } catch (e) {
        alert('粘贴失败: ' + e.message);
    }
});

function updateProductInfo(product) {
    const info = document.getElementById('product-info');
    const titleEn = product.seo_title_en || product.seo_title || product.title_en || '';
    const titleCn = product.seo_title_cn || product.title_cn || '';
    const title = titleEn || titleCn || '无标题';
    info.innerHTML = `
        <div style="font-size:11px;color:#666;margin-bottom:4px;">当前产品 (行${product.row})</div>
        <div style="font-weight:500;color:#333;line-height:1.3;word-break:break-all;font-size:12px;">${titleEn}</div>
        ${titleCn ? '<div style="font-size:12px;color:#555;line-height:1.3;word-break:break-all;margin-top:2px;">' + titleCn + '</div>' : ''}
        <div style="font-size:10px;color:#999;margin-top:4px;">
            类目: ${product.category || '未设置'} | 主图: row${product.row}_main.png
        </div>
    `;
}

chrome.storage.local.get(STORAGE_KEY, (result) => {
    if (result[STORAGE_KEY]) {
        updateProductInfo(result[STORAGE_KEY]);
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue) {
        updateProductInfo(changes[STORAGE_KEY].newValue);
    }
});

// ========== 配置导入导出 ==========

// 导出：把 CONFIG_EXPORT_KEYS 列出的配置打包成 JSON 文件下载
document.getElementById('export-config')?.addEventListener('click', () => {
    chrome.storage.local.get(CONFIG_EXPORT_KEYS, (result) => {
        const payload = {
            __type: 'polo-config-export',
            __version: 1,
            __exportedAt: new Date().toISOString(),
            data: result
        };
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `polo-config-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
});

// 导入：读取用户上传的 JSON，校验后写入 storage 并刷新 UI
document.getElementById('import-config')?.addEventListener('click', () => {
    document.getElementById('import-config-input').click();
});

document.getElementById('import-config-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || parsed.__type !== 'polo-config-export' || !parsed.data) {
            alert('❌ 不是有效的配置文件（缺少 polo-config-export 标识）');
            return;
        }
        const data = parsed.data;
        // 通知 background 同步配置（imageDir / colorImgDir）
        await new Promise((resolve) => {
            const cfg = {
                imageDir: data['polo_image_dir'] || '',
                colorImgDir: data[COLOR_IMG_DIR_KEY] || ''
            };
            chrome.runtime.sendMessage({ action: 'updateConfig', config: cfg }, () => resolve());
        });
        // 写入其余键
        await new Promise((resolve) => {
            chrome.storage.local.set(data, () => resolve());
        });
        alert('✅ 配置导入成功，UI 即将刷新');
        // 重新加载各输入框
        loadHelperPath();
        loadColorImgDir();
        loadHistoryIntoSelect('helper-path-history', HELPER_PATH_HISTORY_KEY);
        loadHistoryIntoSelect('color-img-dir-history', COLOR_IMG_DIR_HISTORY_KEY);
        checkWizard();
    } catch (err) {
        alert('❌ 导入失败: ' + err.message);
    } finally {
        // 允许重复选同一文件
        e.target.value = '';
    }
});

// ========== 启动 ==========

initExtIdDisplay();
checkWizard();

