importScripts('upload/page2_upload.js', 'upload/page3_upload.js', 'suite/suite-task.js');

const STORAGE_KEY = 'polo_product_data';
const DEFAULT_FILE_FOLDER = '默认'; // 颜色图默认子目录名（CURRENT_FILENAME 为空时使用）；历史路径一直是 '默认'，勿改 'default'（buildColorImagePath 读盘同源）
const SAFE_FILENAME_RE = /^[a-zA-Z0-9\u4e00-\u9fff._-]+$/; // M2-① 下载文件名白名单（禁路径分隔符/绝对路径/..）
// L3：Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式）下载会失败/改名
const RESERVED_WIN_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function isReservedWindowsName(filename) {
    return RESERVED_WIN_NAME_RE.test(String(filename || '').split('.')[0]);
}
// M4：仅放行 raster 图片类型（排除 image/svg+xml——含脚本的 SVG 本地打开可在 file:// 上下文执行）
function isRasterImageType(blobType) {
    return /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(String(blobType || ''));
}
const IMAGE_DIR_KEY = 'polo_image_dir';
const COLOR_IMG_DIR_KEY = 'polo_color_img_dir';
const PENDING_COLOR_TASK_KEY = 'polo_pending_color_task';
const DOUBAO_TAB_ID_KEY = 'polo_doubao_tab_id';
const HELPER_PATH_KEY = 'polo_helper_path'; // popup.js 中配置的发品助手.html 路径（存在 chrome.storage.local）

let IMAGE_DIR = '';
let COLOR_IMG_DIR = '';
let CURRENT_FILENAME = '';
const DOUBAO_URL = 'https://www.doubao.com/chat';

let assistantTabId = null;
let assistantPort = null;

// 发品任务状态改为持久化在 chrome.storage.local（PUBLISH_TASK_KEY），
// 不再使用会随 MV3 休眠消失的内存变量作真相源。

async function ensureConfigLoaded() {
    return new Promise((resolve) => {
        chrome.storage.local.get([IMAGE_DIR_KEY, COLOR_IMG_DIR_KEY, 'current_filename'], (result) => {
            if (result[IMAGE_DIR_KEY]) IMAGE_DIR = result[IMAGE_DIR_KEY];
            if (result[COLOR_IMG_DIR_KEY]) COLOR_IMG_DIR = result[COLOR_IMG_DIR_KEY];
            if (result['current_filename']) CURRENT_FILENAME = result['current_filename'];
            resolve();
        });
    });
}

// H1 第1层：外部消息来源校验（Chrome 提供的 sender.url 不可伪造）
async function isTrustedSender(sender) {
    const url = sender?.url || '';
    // 注意：扩展自身页面走 onMessage（内部消息），不会进入 onMessageExternal；
    // 此处出现的 chrome-extension:// 来源只可能是其他扩展，一律拒绝（review blocking 修复）
    if (!url.startsWith('file://')) return false;
    let path;
    try {
        path = decodeURIComponent(url.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '')).replace(/\//g, '\\');
    } catch (e) {
        console.warn('[isTrustedSender] 非法 file:// URL，拒绝:', url);
        return false;
    }
    // 优先精确匹配 popup 已配置的 helperPath（发品助手.html 的本地路径）
    const helper = await new Promise(r => chrome.storage.local.get(HELPER_PATH_KEY, v => r(v[HELPER_PATH_KEY] || '')));
    if (helper) {
        const helperNorm = helper.replace(/\//g, '\\').toLowerCase();
        const pathLower = path.toLowerCase();
        if (pathLower === helperNorm) return true; // 绝对路径：完整相等
        if (!helperNorm.includes('\\') && !helperNorm.includes(':')) {
            // 相对路径（仅文件名）：结尾匹配
            return pathLower.endsWith('\\' + helperNorm) || pathLower.endsWith('/' + helperNorm);
        }
        return false;
    }
    // 未配置 helperPath 时兜底：文件名包含"发品助手"
    return path.includes('发品助手');
}

// M3：目录配置值校验
// 空串/空值 = 显式清空目录（popup.js:191 与 发品助手.html:1985 支持清空），放行；
// 非空值校验格式：拒绝盘符根/控制字符/路径穿越段（.. / .）
function isValidDir(v) {
    if (v === '' || v === null || v === undefined) return true; // 显式清空
    if (typeof v !== 'string' || !v.trim()) return false;
    if (/^[a-zA-Z]:[\\/]?$/.test(v.trim())) return false; // 盘符根
    if (v.includes('\0') || v.includes('\n') || v.includes('\r')) return false;
    const segs = v.split(/[\\/]+/).filter(Boolean);
    if (segs.some(s => s === '..' || s === '.')) return false; // 防目录逃逸
    return true; // 单字符目录（如「图」）合法
}

let downloadFilenameMap = new Map(); // downloadId -> { filename, relativePath, url }

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    let mapping = downloadFilenameMap.get(downloadItem.id);
    // 兜底：download() 回调与 onDeterminingFilename 的触发顺序无硬性保证，
    // id 未命中时按下载 URL 匹配（data: 或原始 URL 均与传入 downloadUrl 一致）
    if (!mapping && downloadItem.url) {
        for (const m of downloadFilenameMap.values()) {
            if (m.url === downloadItem.url) {
                mapping = m;
                break;
            }
        }
    }
    if (mapping) {
        console.log(`[download] 强制文件名: id=${downloadItem.id} -> ${mapping.relativePath}`);
        suggest({ filename: mapping.relativePath, conflictAction: 'overwrite' });
        // 删除匹配条目：url 兜底命中时 key 不是 downloadItem.id，需按映射对象删除
        for (const [k, v] of downloadFilenameMap) {
            if (v === mapping) { downloadFilenameMap.delete(k); break; }
        }
    } else {
        // 契约：listener 必须恰好调用一次 suggest；未命中时显式空参调用，
        // 否则 Chrome 自动 suggest 后文件名不可控（表现为「下载 - 时间戳.png」）
        suggest();
    }
});

// savePublishQueue 已废弃：队列状态统一由 savePublishTask() 写入 PUBLISH_TASK_KEY

async function savePendingColorTask(task) {
    return new Promise((resolve) => {
        if (task) {
            chrome.storage.local.set({ [PENDING_COLOR_TASK_KEY]: task }, resolve);
        } else {
            chrome.storage.local.remove(PENDING_COLOR_TASK_KEY, resolve);
        }
    });
}

async function getPendingColorTask() {
    return new Promise((resolve) => {
        chrome.storage.local.get(PENDING_COLOR_TASK_KEY, (result) => {
            resolve(result[PENDING_COLOR_TASK_KEY] || null);
        });
    });
}

async function saveDoubaoTabId(tabId) {
    return new Promise((resolve) => {
        if (tabId) {
            chrome.storage.local.set({ [DOUBAO_TAB_ID_KEY]: tabId }, resolve);
        } else {
            chrome.storage.local.remove(DOUBAO_TAB_ID_KEY, resolve);
        }
    });
}

async function getDoubaoTabId() {
    return new Promise((resolve) => {
        chrome.storage.local.get(DOUBAO_TAB_ID_KEY, (result) => {
            resolve(result[DOUBAO_TAB_ID_KEY] || null);
        });
    });
}

// ============================================================
// 发品任务：分批预填 + 资源闸门 + 停止/继续
// 真相源一律在 chrome.storage.local，不依赖会随 MV3 休眠消失的内存变量
// ============================================================
const PUBLISH_TASK_KEY = 'polo_publish_task';
const PUBLISH_LOG_KEY = 'polo_publish_log';
const PUBLISH_LOG_MAX = 500;
const PUBLISH_SETTINGS_KEY = 'polo_publish_settings';
const PUBLISH_VERIFIED_SAVED_KEY = 'polo_publish_verified_saved';   // 保存记录（用户定义：页3菜单点击保存；记录来源）
const PUBLISH_LEGACY_UPLOADED_KEY = 'polo_publish_legacy_uploaded'; // 旧 uploaded 标记：历史待核，仅供展示
const PUBLISH_TICK_MS = 30000;                          // 运行期资源巡检间隔上限

const PUBLISH_DEFAULTS = {
    batchSize: 50,          // 每批固定预填 50 款
    rowTimeoutMs: 600000    // 单行超时 10 分钟
};

let publishTickTimer = null;

// ---------- 异步互斥：所有任务状态变更串行执行（持久化 ≠ 互斥） ----------
// 重复完成消息并发到达时，只有第一个能推进；后续在锁内重读状态后会被拒绝。
let publishOpChain = Promise.resolve();
function withPublishLock(fn) {
    const run = publishOpChain.then(fn, fn);
    publishOpChain = run.then(() => {}, () => {});
    return run;
}

// 巡检用 alarm（可唤醒被 MV3 回收的后台）；setInterval 只作同进程加速
const PUBLISH_TICK_ALARM = 'publishTick';

// 停止闸门：收到停止意图时【立即】置位，不受互斥链排队影响。
// 用「代次(epoch)」区分"操作开始前的旧停止"与"操作开始后新到达的停止"：
//   - 用户明确继续/重试/新建 → beginPublishRunIntent()：清掉旧停止并记录当前代次
//   - 之后任何停止 → markPublishStop()：代次 +1，置位
//   - 开页前最终确认 publishStopBlocked()：被置位 或 代次已变 → 禁止创建新页
let publishStopRequested = false;
let publishStopEpoch = 0;   // 每次停止意图 +1
let publishRunEpoch = 0;    // 最近一次"明确要继续/重试/新建"时的停止代次

function markPublishStop() {
    publishStopRequested = true;
    publishStopEpoch += 1;
}

// 只能在操作【开始时】调用：清除开始前已存在的旧停止，不能覆盖开始后新到达的停止
function beginPublishRunIntent() {
    publishStopRequested = false;
    publishRunEpoch = publishStopEpoch;
    return publishRunEpoch;
}

// 该操作/请求开始后是否收到了"新的停止"（epoch 只增不减）
// epochRef 应是【用户请求被接收时】捕获的代次，而不是取得锁之后的代次
function publishStoppedSince(epochRef) {
    return publishStopEpoch !== epochRef;
}

// 通过合法性检查后调用：解除"本请求开始前"的旧停止。
// epochRef 必须仍等于当前代次（等待锁/异步期间没有新的停止），否则不动任何状态。
function beginPublishRunIntentFrom(epochRef) {
    if (publishStopEpoch !== epochRef) return false;
    publishStopRequested = false;
    publishRunEpoch = epochRef;
    return true;
}

// 最终开页前确认：是否已被停止（含操作开始后新到达的停止）
function publishStopBlocked(epochRef) {
    if (publishStopRequested) return true;
    if (epochRef === undefined || epochRef === null) return publishStopEpoch !== publishRunEpoch;
    return publishStopEpoch !== epochRef;
}

// 单行重试上限（重试会重置批次计数，需另设上限防止无限开页）
const PUBLISH_ROW_RETRY_MAX = 5;

// 允许重试的暂停原因（只有这些"卡住"状态才谈得上重试）
const RETRYABLE_REASONS = ['tabClosed', 'rowTimeout', 'openFail'];

// 任务绑定的文件标识：空字符串也是合法绑定值（未设置文件名时 getFilePrefix() 返回 ''）
function taskFileKey(t) {
    return (t && t.fileKey !== undefined && t.fileKey !== null) ? String(t.fileKey) : '';
}

// 统一开页前置闸门：状态 / 停止意图 / 文件一致性 / 在填页面 / 资源与页面上限
// 所有开页入口（普通推进、重试）都必须先过这里
async function canOpenPublishPage(t, opts) {
    const o = opts || {};
    if (!t) return { ok: false, reason: 'noTask', detail: '没有发品任务' };
    if (t.state !== 'running' && !o.allowPaused) {
        return { ok: false, reason: 'notRunning', detail: '任务未在运行' };
    }
    if (publishStopBlocked()) {
        return { ok: false, reason: 'stopping', detail: '已收到停止请求，不再开新页' };
    }
    const cur = getFilePrefix();
    const tf = taskFileKey(t);
    if (tf !== cur) {
        return { ok: false, reason: 'fileSwitch', detail: `当前文件与任务绑定文件不一致（任务 ${tf || '(无文件名)'} / 当前 ${cur || '(无文件名)'}）` };
    }
    if (t.currentRow !== null && !o.allowCurrentRow) {
        return { ok: false, reason: 'busy', detail: '已有正在填写的行' };
    }
    const g = await checkPublishResources();
    if (!g.ok) {
        return { ok: false, reason: g.reasons[0].reason, detail: g.reasons.map(x => x.detail).join('；') };
    }
    return { ok: true, g };
}

// ---------- 设置（持久化 + 边界收敛） ----------
async function getPublishSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(PUBLISH_SETTINGS_KEY, (r) => {
            const settings = { ...PUBLISH_DEFAULTS, ...(r[PUBLISH_SETTINGS_KEY] || {}), batchSize: 50 };
            delete settings.pageLimit;
            resolve(settings);
        });
    });
}

async function setPublishSettings(patch) {
    return withPublishLock(async () => {
        const cur = await getPublishSettings();
        const next = { ...cur, ...patch };
        next.batchSize = 50;
        delete next.pageLimit;
        next.rowTimeoutMs = Math.max(60000, parseInt(next.rowTimeoutMs, 10) || PUBLISH_DEFAULTS.rowTimeoutMs);
        await new Promise(r => chrome.storage.local.set({ [PUBLISH_SETTINGS_KEY]: next }, r));

        // 暂停中的任务：立即同步为"下一批"的设置（运行中不改当前批次，避免计数错乱）
        const t = await loadPublishTask();
        if (t && t.state === 'paused') {
            t.batchSize = next.batchSize;
            t.pageLimit = next.pageLimit;
            t.rowTimeoutMs = next.rowTimeoutMs;
            await savePublishTask(t);
        }
        return next;
    });
}

// ---------- 任务持久化 ----------
async function loadPublishTask() {
    return new Promise((resolve) => {
        chrome.storage.local.get(PUBLISH_TASK_KEY, (r) => {
            const task = r[PUBLISH_TASK_KEY] || null;
            if (task) {
                task.batchSize = 50;
                delete task.pageLimit;
                if (task.state === 'paused' && ['memory', 'monitorFail', 'pageLimit'].includes(task.pauseReason)) {
                    task.pauseReason = 'manual';
                    task.pauseDetail = '上次任务已暂停，等待你继续（每批 50 款，无需内存服务）';
                    task.resourceBlockDetail = '';
                }
            }
            resolve(task);
        });
    });
}

async function savePublishTask(task) {
    return new Promise((resolve, reject) => {
        const done = () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error('保存发品任务失败：' + err.message)); else resolve();
        };
        if (!task) { chrome.storage.local.remove(PUBLISH_TASK_KEY, done); return; }
        chrome.storage.local.set({ [PUBLISH_TASK_KEY]: task }, done);
    });
}

// ---------- 诊断日志（有界 500 条；只记数值与标识，不记凭据/文案/图片） ----------
async function appendPublishLog(entry) {
    try {
        const r = await new Promise(res => chrome.storage.local.get(PUBLISH_LOG_KEY, res));
        const list = Array.isArray(r[PUBLISH_LOG_KEY]) ? r[PUBLISH_LOG_KEY] : [];
        list.push({ t: Date.now(), ...entry });
        while (list.length > PUBLISH_LOG_MAX) list.shift();
        await new Promise(res => chrome.storage.local.set({ [PUBLISH_LOG_KEY]: list }, res));
    } catch (_) {}
}

// ---------- 目标页面统计（全部 easyListing/publish 顶层标签，含旧批次与已保存页面） ----------
function isTargetPublishUrl(url) {
    if (!url) return false;
    return /^https?:\/\/post\.alibaba\.com\/product\/(easyListing|publish)/.test(url);
}

async function countTargetTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(t => isTargetPublishUrl(t.url)).length;
}

// 页面数量仅用于诊断；不限制总页面数、不采样内存、不请求本地服务。
async function checkPublishResources() {
    const settings = await getPublishSettings();
    const pages = await countTargetTabs();
    return { ok: true, reasons: [], pages, settings, mem: {}, threshold: null };
}

function stopPublishTick() {
    try { if (chrome.alarms) chrome.alarms.clear(PUBLISH_TICK_ALARM); } catch (_) {}
    if (publishTickTimer) { clearInterval(publishTickTimer); publishTickTimer = null; }
}

// 巡检保活：alarm 可唤醒被 MV3 回收的后台；setInterval 仅作同进程加速
function ensurePublishTick() {
    try {
        if (chrome.alarms) chrome.alarms.create(PUBLISH_TICK_ALARM, { periodInMinutes: 0.5 }); // 30 秒
    } catch (_) {}
    if (!publishTickTimer) {
        publishTickTimer = setInterval(() => { publishTickOnce(); }, PUBLISH_TICK_MS);
    }
}

// 通知「发品助手」页（沿用 notifyColorTaskComplete 的三级通道）
function notifyAssistant(action, payload) {
    const msg = { action, ...payload };
    if (assistantPort) {
        try { assistantPort.postMessage(msg); return; } catch (_) { assistantPort = null; }
    }
    if (assistantTabId) {
        chrome.tabs.sendMessage(assistantTabId, msg).catch(() => {});
    }
    try { chrome.runtime.sendMessage(EXTENSION_ID, msg, () => void chrome.runtime.lastError); } catch (_) {}
}

// ---------- 状态播报 ----------
function publishRunning(t) { return !!t && t.state === 'running'; }

async function buildPublishStatePayload() {
    const t = await loadPublishTask();
    const pages = await countTargetTabs();
    const settings = await getPublishSettings();
    // 用户的保存记录按文件隔离；本任务只统计其选中行，不包含同文件其他任务。
    const fileKey = t ? taskFileKey(t) : getFilePrefix();
    const savedMap = await getVerifiedSavedMap(fileKey);
    const taskRows = t ? new Set(Object.keys(t.products || {}).concat((t.remaining || []).map(String), (t.filledRows || []).map(String))) : null;
    const savedCount = Object.keys(savedMap).filter(row => !taskRows || taskRows.has(row)).length;
    const filledRows = (t && Array.isArray(t.filledRows)) ? t.filledRows : [];
    const pendingSaveCount = filledRows.filter(r => !savedMap[r]).length;
    return {
        ok: true,
        state: t ? t.state : 'idle',
        taskId: t ? t.taskId : null,
        fileKey,
        batchSize: t ? t.batchSize : settings.batchSize,   // idle 时显示真实设置值，不是硬编码 50
        settingsBatchSize: settings.batchSize,
        editableBatchSize: !t || t.state !== 'running',     // 运行中不允许改当前批次
        batchOpened: t ? (t.batchFilled || 0) : 0,          // 本批已开页数
        batchFilled: t ? (t.batchFilledDone || 0) : 0,      // 本批已填完数
        filledCount: t ? t.filledCount : 0,
        total: t ? t.total : 0,
        remaining: t ? t.remaining.length : 0,
        pendingSaveCount,
        savedCount,
        pauseReason: t ? t.pauseReason : '',
        pauseDetail: t ? t.pauseDetail : '',
        // 行失效状态与资源暂停原因分开：界面按 rowRetryable 决定是否显示重试/跳过
        currentRowFailure: t ? (t.currentRowFailure || '') : '',
        rowRetryable: !!(t && t.currentRow !== null && rowFailureOf(t)),
        rowRetries: t ? (t.currentRowRetries || 0) : 0,
        resourceBlockDetail: t ? (t.resourceBlockDetail || '') : '',
        currentRow: t ? t.currentRow : null,
        pages,
        pageLimit: t ? t.pageLimit : settings.pageLimit
    };
}

async function broadcastPublishState(extra) {
    const payload = await buildPublishStatePayload();
    notifyAssistant('publishState', { ...payload, ...(extra || {}) });
}

// 保存记录：按文件隔离，保留 source；人工菜单点击规则不冒充平台成功信号。
// 注意：fileKey 允许为空字符串（未设置文件名时 getFilePrefix() 返回 ''），不能用 && 判断
async function getVerifiedSavedMap(fileKey) {
    const r = await new Promise(res => chrome.storage.local.get(PUBLISH_VERIFIED_SAVED_KEY, res));
    const all = r[PUBLISH_VERIFIED_SAVED_KEY] || {};
    const key = (fileKey === undefined || fileKey === null) ? '' : String(fileKey);
    return all[key] || {};
}

// 页3人工保存入口：点击与记账在后台完成，保存触发页面刷新也不会丢失记账。
async function savePublishProduct(request, sender, clickButton = true) {
    return withPublishLock(async () => {
        const tabId = sender && sender.tab && sender.tab.id;
        let page;
        try { page = new URL(sender.url || sender.tab?.url || ''); } catch (_) {}
        if (!tabId || !page || page.hostname !== 'post.alibaba.com' || !page.pathname.startsWith('/product/publish')
            || (sender.frameId !== undefined && sender.frameId !== 0)) return { ok: false, error: '仅允许页3保存入口' };
        const row = Number(request.row), x = Number(request.x), y = Number(request.y);
        if (!Number.isInteger(row) || row <= 0 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { ok: false, error: '保存产品或按钮位置无效' };
        const t = await loadPublishTask();
        let fileKey;
        if (request.taskId && t && t.taskId === request.taskId) {
            const belongs = t.products ? Object.prototype.hasOwnProperty.call(t.products, String(row))
                : [...(t.remaining || []), ...(t.filledRows || [])].some(r => Number(r) === row);
            if (!belongs) return { ok: false, error: '产品行不属于该任务' };
            fileKey = taskFileKey(t);
        } else if (typeof request.fileKey === 'string') {
            fileKey = request.fileKey; // 原任务页保存到原文件，不使用后来切换的新文件。
        } else if (request.taskId) return { ok: false, error: '原任务文件信息缺失，未记入其他文件' };
        else fileKey = getFilePrefix();

        let clicked = clickButton ? await realClickCDP(tabId, x, y) : { ok: true };
        if (!clicked.ok) {
            try {
                const results = await chrome.scripting.executeScript({ target: { tabId }, args: [x, y], func: (px, py) => {
                    const button = document.elementFromPoint(px, py)?.closest('button');
                    if (!button || (button.innerText || button.textContent || '').trim() !== '保存') return false;
                    button.click(); return true;
                } });
                clicked = { ok: results.some(r => r.result === true) };
            } catch (_) {}
        }
        if (!clicked.ok) return { ok: false, error: '保存按钮未点击，未标记已保存' };
        const stored = await new Promise(resolve => chrome.storage.local.get(PUBLISH_VERIFIED_SAVED_KEY, resolve));
        const all = stored[PUBLISH_VERIFIED_SAVED_KEY] || {};
        all[fileKey] = { ...(all[fileKey] || {}), [row]: { at: Date.now(), source: 'page3_save_click', taskId: request.taskId || null } };
        await new Promise((resolve, reject) => chrome.storage.local.set({ [PUBLISH_VERIFIED_SAVED_KEY]: all }, () => {
            if (chrome.runtime.lastError) reject(new Error('已点击保存，但保存记录写入失败：' + chrome.runtime.lastError.message));
            else resolve();
        }));
        notifyAssistant('publishSaved', { row, fileKey, source: 'page3_save_click' });
        await broadcastPublishState();
        return { ok: true, row, fileKey, source: 'page3_save_click' };
    });
}

// ---------- 暂停 / 继续 ----------
// 内部实现：假定调用方已持锁（withPublishLock）
async function pausePublishTaskLocked(reason, detail) {
    const t = await loadPublishTask();
    if (!t || t.state === 'done') return;
    const first = t.state !== 'paused' || t.pauseReason !== reason;
    t.state = 'paused';
    t.pauseReason = reason;
    t.pauseDetail = detail || '';
    await savePublishTask(t);
    stopPublishTick();
    console.warn(`⏸ 发品任务已暂停 [${reason}] ${detail || ''}（剩 ${t.remaining.length} 款）`);
    if (first) {
        await appendPublishLog({ level: 'pause', reason, detail, row: t.currentRow, pages: await countTargetTabs() });
        await broadcastPublishState({ justPaused: true });
    }
}

function pausePublishTask(reason, detail) {
    return withPublishLock(() => pausePublishTaskLocked(reason, detail));
}

// 当前行是否"已失效、可重试"。与资源暂停原因分开保存：
//   currentRowFailure = rowTimeout/tabClosed/openFail（行本身失效，重试/继续的判断依据）
//   pauseReason       = 最近一次暂停原因，可能是 memory/pageLimit/monitorFail 等资源原因
// 资源保护不得清除"当前行可重试"这一事实。
function rowFailureOf(t) {
    if (!t || t.currentRow === null) return '';
    if (t.currentRowFailure) return t.currentRowFailure;
    return RETRYABLE_REASONS.indexOf(t.pauseReason) >= 0 ? t.pauseReason : '';
}

// 行失效导致的暂停：同时记录 currentRowFailure
async function pauseForRowFailureLocked(reason, detail) {
    const t = await loadPublishTask();
    if (t && t.currentRow !== null) {
        t.currentRowFailure = reason;
        await savePublishTask(t);
    }
    await pausePublishTaskLocked(reason, detail);
}

// 资源导致的暂停：只更新资源原因，不动 currentRowFailure
async function pauseForResourceLocked(reason, detail) {
    const t = await loadPublishTask();
    if (t) {
        t.resourceBlockDetail = detail || '';
        await savePublishTask(t);
    }
    await pausePublishTaskLocked(reason, detail);
}

async function resumePublishTask() {
    // ① 在进入串行队列【之前】捕获停止代次：等待锁也是本次操作等待的一部分
    const epochAtRequest = publishStopEpoch;
    return withPublishLock(async () => {
    // ② 等待锁期间收到更晚的停止 → 拒绝，且绝不清除它
    if (publishStoppedSince(epochAtRequest)) {
        notifyAssistant('publishResumeRejected', { message: '排队期间收到停止请求，未继续' });
        return { ok: false, message: '排队期间收到停止请求，未继续' };
    }
    const t = await loadPublishTask();
    if (!t) { notifyAssistant('publishResumeRejected', { message: '没有可继续的发品任务' }); return { ok: false, message: '没有可继续的发品任务' }; }
    if (t.state === 'running') { notifyAssistant('publishResumeRejected', { message: '任务正在运行中' }); return { ok: false, message: '任务正在运行中' }; }
    if (t.remaining.length === 0) { notifyAssistant('publishResumeRejected', { message: '队列已空' }); return { ok: false, message: '队列已空' }; }

    // 当前行处于"已失效"状态：不能靠"继续"空等，必须走明确的重试/跳过
    const rowFailR = rowFailureOf(t);
    if (t.currentRow !== null && rowFailR) {
        const msg = `第 ${t.currentRow} 行需要明确处理（${rowFailR}）：请点「↻ 重试当前行」重开该页，或「⏭ 跳过当前行」`;
        notifyAssistant('publishResumeRejected', { message: msg });
        return { ok: false, message: msg };
    }

    // ③ 合法性检查全部通过 → 才允许解除"本请求开始前"的旧停止
    if (!beginPublishRunIntentFrom(epochAtRequest)) {
        notifyAssistant('publishResumeRejected', { message: '排队期间收到停止请求，未继续' });
        return { ok: false, message: '排队期间收到停止请求，未继续' };
    }

    // 继续前重新检查页面数量上限
    const g = await checkPublishResources(true);
    if (!g.ok) {
        const detail = g.reasons.map(x => x.detail).join('；');
        await pauseForResourceLocked(g.reasons[0].reason, detail);   // 只更新资源原因，不动行失效事实
        notifyAssistant('publishResumeRejected', { message: '资源条件不满足：' + detail });
        return { ok: false, message: '资源条件不满足：' + detail };
    }

    // 文件一致性：继续前必须与任务绑定文件一致（空 fileKey 也是合法绑定值）
    if (taskFileKey(t) !== getFilePrefix()) {
        const d = `当前文件与任务绑定文件不一致（任务 ${taskFileKey(t) || '(无文件名)'} / 当前 ${getFilePrefix() || '(无文件名)'}）`;
        await pausePublishTaskLocked('fileSwitch', d);
        notifyAssistant('publishResumeRejected', { message: d });
        return { ok: false, message: d };
    }

    // 继续前同步最新设置（每批款数 / 页面上限 / 行超时），使界面上改的批次真正生效
    const s = await getPublishSettings();
    t.batchSize = s.batchSize;
    t.pageLimit = s.pageLimit;
    t.rowTimeoutMs = s.rowTimeoutMs;

    // 设置读取期间若收到停止请求 → 保持暂停，不继续（不覆盖本请求开始后新到达的停止）
    if (publishStoppedSince(epochAtRequest)) {
        notifyAssistant('publishResumeRejected', { message: '已收到停止请求，未继续' });
        return { ok: false, message: '已收到停止请求，未继续' };
    }

    t.state = 'running';
    t.pauseReason = '';
    t.pauseDetail = '';
    // 当前仍有在填页面：只恢复等待该标签，不重置批次、不开新页
    if (t.currentRow === null) {
        t.batchFilled = 0;      // 新一批
        t.batchFilledDone = 0;
    }
    await savePublishTask(t);
    await appendPublishLog({ level: 'resume', row: t.currentRow, pages: g.pages });
    ensurePublishTick();
    notifyAssistant('publishResumed', { remaining: t.remaining.length, batchSize: t.batchSize, waitingCurrent: t.currentRow !== null });
    await broadcastPublishState();
    if (t.currentRow === null) {
        await processPublishQueueLocked();
    }
    return { ok: true };
    });
}

// ---------- 打开下一个标签（唯一开页入口） ----------
// 紧邻 tabs.create 前做最终停止确认：尚未调用 tabs.create 时收到停止，一律不创建。
// epochRef：本次开页所属操作的停止代次（普通推进传 publishRunEpoch；继续/重试传请求时捕获的代次）
async function openPublishTab(rowNum, taskId, epochRef) {
    if (publishStopBlocked(epochRef)) {
        console.warn('⛔ 开页前确认到停止请求，未创建新页');
        return { blocked: true, reason: 'stopping' };
    }
    const baseUrl = 'https://post.alibaba.com/product/easyListing.htm?spm=a2700.micro_product_manager.0.0.40e03e5fPaTwSu';
    const url = baseUrl + '&row=' + rowNum + '&task=' + encodeURIComponent(taskId);
    const tab = await chrome.tabs.create({ url });
    console.log(`🆕 已打开第${rowNum}行产品发品页面 (tab ${tab.id})`);
    return tab;
}

// ---------- 巡检体（幂等；锁内执行；唤醒后先校验，不直接开页） ----------
async function publishTickOnce() {
    return withPublishLock(async () => {
        const t = await loadPublishTask();
        if (!publishRunning(t)) { stopPublishTick(); return; }

        // 文件切换检查：任务绑定文件 ≠ 当前文件 → 暂停，防串数据
        if (taskFileKey(t) !== getFilePrefix()) {
            await pausePublishTaskLocked('fileSwitch', `当前文件已切换（任务绑定 ${taskFileKey(t) || '(无文件名)'}），任务已暂停以防数据互串`);
            return;
        }
        // 当前行超时
        if (t.currentRow !== null && t.currentStartedAt && Date.now() - t.currentStartedAt > t.rowTimeoutMs) {
            await pauseForRowFailureLocked('rowTimeout', `第 ${t.currentRow} 行填写超时（>${Math.round(t.rowTimeoutMs / 60000)} 分钟）`);
            return;
        }
        // 当前标签是否被用户关闭
        if (t.currentTabId !== null) {
            try {
                await chrome.tabs.get(t.currentTabId);
            } catch (_) {
                await pauseForRowFailureLocked('tabClosed', `第 ${t.currentRow} 行所在标签已被关闭，该行保留在队列`);
                return;
            }
        }
        const g = await checkPublishResources();
        if (!g.ok) {
            await pauseForResourceLocked(g.reasons[0].reason, g.reasons.map(x => x.detail).join('；'));
        }
    });
}

// ---------- 队列推进（锁内实现；公开入口自动加锁） ----------
async function processPublishQueueLocked() {
    const t = await loadPublishTask();
    if (!publishRunning(t) || t.remaining.length === 0) return;
    // 已有在填页面：恢复等待该标签，绝不重复开页
    if (t.currentRow !== null) return;

    // 停止闸门：已收到停止请求就不再开新页
    if (publishStopBlocked()) {
        await pausePublishTaskLocked('manual', '已收到停止请求');
        return;
    }

    // 本批已开页数达上限 → 暂停，等用户主动继续（不因关页/保存自动继续）
    if ((t.batchFilled || 0) >= t.batchSize) {
        await pausePublishTaskLocked('batch', `本批已开 ${t.batchFilled}/${t.batchSize} 页达上限，剩 ${t.remaining.length} 款；处理完已开页面后点「继续下一批」`);
        return;
    }

    const pre = await canOpenPublishPage(t);
    if (!pre.ok) {
        if (pre.reason === 'stopping') await pausePublishTaskLocked('manual', pre.detail);
        else if (pre.reason === 'fileSwitch') await pausePublishTaskLocked('fileSwitch', pre.detail);
        else if (pre.reason === 'notRunning' || pre.reason === 'busy' || pre.reason === 'noTask') return;
        else await pauseForResourceLocked(pre.reason, pre.detail);
        return;
    }
    const g = pre.g;

    // 开页前重读状态：停止/文件切换若在资源检查期间到达，不得用旧快照开页
    const t2 = await loadPublishTask();
    if (!publishRunning(t2) || t2.currentRow !== null) return;
    if (publishStopBlocked()) { await pausePublishTaskLocked('manual', '已收到停止请求'); return; }
    if (taskFileKey(t2) !== getFilePrefix()) {
        await pausePublishTaskLocked('fileSwitch', `当前文件与任务绑定文件不一致（任务 ${taskFileKey(t2) || '(无文件名)'} / 当前 ${getFilePrefix() || '(无文件名)'}）`);
        return;
    }

    const rowNum = t2.remaining[0];
    let tab;
    try {
        tab = await openPublishTab(rowNum, t2.taskId, publishRunEpoch);
    } catch (e) {
        await pausePublishTaskLocked('openFail', `第 ${rowNum} 行开页失败：${e.message}`);
        return;
    }
    if (!tab || tab.blocked) {
        // 开页前被停止拦下：未创建任何标签，保持暂停
        await pausePublishTaskLocked('manual', '开页前收到停止请求，未创建新页');
        return;
    }

    t2.currentRow = rowNum;
    t2.currentTabId = tab.id;
    t2.currentStartedAt = Date.now();
    t2.currentRowRetries = 0;
    t2.currentRowFailure = '';
    t2.batchFilled = (t2.batchFilled || 0) + 1;

    if (publishStopBlocked()) {
        // 创建请求已发出（无法撤回）：记账保留该页，保持暂停且不再开下一页，也不自动关闭
        t2.state = 'paused';
        t2.pauseReason = 'manual';
        t2.pauseDetail = '开页途中收到停止请求：已保留当前页，任务保持暂停';
        await savePublishTask(t2);
        stopPublishTick();
        await appendPublishLog({ level: 'open-stop', row: rowNum, tabId: tab.id });
        await broadcastPublishState();
        return;
    }

    await savePublishTask(t2);
    ensurePublishTick();

    await appendPublishLog({
        level: 'open', row: rowNum, tabId: tab.id, state: t2.state,
        batchOpened: t2.batchFilled, filled: t2.filledCount, remain: t2.remaining.length,
        pages: g.pages, physMB: g.mem.physAvailableMB, commitFreeMB: g.mem.commitFreeMB,
        commitUsedPct: g.mem.commitUsedPct, sampledAt: g.mem.sampledAt
    });
    await broadcastPublishState();
}

function processPublishQueue() {
    return withPublishLock(processPublishQueueLocked);
}

// ---------- 收到「填写完成」：校验来源后推进 ----------
// 只接受当前任务 + 当前行 + 当前标签；重复/旧任务/乱序/其他标签一律拒绝
async function onPublishFilled(senderTabId, senderFrameId, msg) {
    return withPublishLock(async () => {
        const t = await loadPublishTask();
        if (!t) return { ok: false, message: '没有进行中的发品任务' };
        const row = parseInt(msg.row, 10);

        // 严格校验：taskId 必填且严格相等；senderTabId 必须有效且等于当前标签；须为顶层框架
        if (!msg.taskId || typeof msg.taskId !== 'string' || msg.taskId !== t.taskId) {
            return { ok: false, message: '任务标识缺失或不匹配，已拒绝' };
        }
        if (senderTabId === undefined || senderTabId === null || senderTabId !== t.currentTabId) {
            return { ok: false, message: '非当前标签的消息，已拒绝' };
        }
        if (senderFrameId !== undefined && senderFrameId !== null && senderFrameId !== 0) {
            return { ok: false, message: '非顶层框架消息，已拒绝' };
        }
        if (row !== t.currentRow) return { ok: false, message: `行号不匹配（当前 ${t.currentRow}），已拒绝` };

        // 记录填写完成。暂停中也接受：当前页的有效完成必须入账，只是不自动开新页。
        const wasPaused = t.state === 'paused';
        t.remaining.shift();
        t.filledCount += 1;
        if (!Array.isArray(t.filledRows)) t.filledRows = [];
        t.filledRows.push(row);
        t.batchFilledDone = (t.batchFilledDone || 0) + 1;
        t.currentRow = null;
        t.currentTabId = null;
        t.currentStartedAt = 0;
        t.currentRowRetries = 0;   // 该行已入账，重试计数归零
        t.currentRowFailure = '';  // 行已成功填写，失效状态清除
        t.resourceBlockDetail = '';
        await savePublishTask(t);
        await appendPublishLog({ level: 'filled', row, filled: t.filledCount, remain: t.remaining.length, batchFilled: t.batchFilledDone, paused: wasPaused });

        if (t.remaining.length === 0) {
            t.state = 'done';
            t.pauseReason = '';
            t.pauseDetail = '';
            await savePublishTask(t);
            stopPublishTick();
            await appendPublishLog({ level: 'done', filled: t.filledCount, total: t.total });
            notifyAssistant('publishAllFilled', { filled: t.filledCount, total: t.total });
            await broadcastPublishState();
            return { ok: true, done: true };
        }

        notifyAssistant('publishFilledAck', { row, filled: t.filledCount, total: t.total, remaining: t.remaining.length });
        await broadcastPublishState();
        // 只在运行中自动开下一款；暂停状态保持暂停（等用户主动继续）
        if (!wasPaused) {
            await processPublishQueueLocked();
        }
        return { ok: true, remaining: t.remaining.length };
    });
}

// ---------- 单行重试 / 明确跳过（用户主动触发） ----------
// 语义：异常行「带入下一批」—— 重试重置下一批计数并把该页计入新批次；
//       不再受"本批已开数"上限阻挡（否则每批最后一款失败后无法恢复）。
//       仍受 页面总量 / 文件 / 停止 闸门限制，另有单行重试上限防无限开页。
async function retryPublishRow() {
    // ① 进入串行队列【之前】捕获停止代次
    const epochAtRequest = publishStopEpoch;
    return withPublishLock(async () => {
        // ② 等待锁期间收到更晚的停止 → 拒绝，不清除
        if (publishStoppedSince(epochAtRequest)) {
            return { ok: false, message: '排队期间收到停止请求，未重试' };
        }
        const t = await loadPublishTask();
        if (!t) return { ok: false, message: '没有发品任务' };
        if (t.state === 'running') return { ok: false, message: '任务正在运行，不能重试' };
        if (t.state !== 'paused') return { ok: false, message: '当前状态不可重试' };
        if (t.currentRow === null) return { ok: false, message: '当前没有待重试的行' };

        // 合法性依据【行失效状态】，而不是最近一次暂停原因（资源暂停不得抹掉行可重试的事实）
        const rowFail = rowFailureOf(t);
        if (!rowFail) {
            return { ok: false, message: `当前行没有可重试的失效状态（暂停原因：${t.pauseReason || '无'}）；请用「继续下一批」` };
        }
        if ((t.currentRowRetries || 0) >= PUBLISH_ROW_RETRY_MAX) {
            return { ok: false, message: `该行已重试 ${t.currentRowRetries} 次达上限，请「跳过当前行」或检查页面` };
        }

        // ③ 合法性检查通过 → 才解除"本请求开始前"的旧停止
        if (!beginPublishRunIntentFrom(epochAtRequest)) {
            return { ok: false, message: '排队期间收到停止请求，未重试' };
        }

        const pre = await canOpenPublishPage(t, { allowPaused: true, allowCurrentRow: true });
        if (!pre.ok) {
            // 资源原因只更新资源信息，保留 currentRowFailure（资源恢复后仍可重试）
            if (pre.reason !== 'stopping') await pauseForResourceLocked(pre.reason, pre.detail);
            return { ok: false, message: pre.detail };
        }

        // 重试 = 该异常行进入下一批：资源检查通过后才重置下一批计数
        t.batchFilled = 0;
        t.batchFilledDone = 0;

        const row = t.currentRow;
        let tab;
        try {
            tab = await openPublishTab(row, t.taskId, epochAtRequest);
        } catch (e) {
            return { ok: false, message: '重开失败：' + e.message };
        }
        if (!tab || tab.blocked) {
            return { ok: false, message: '已收到停止请求，未重试（未创建新页）' };
        }

        // 标签已创建（无法撤回）：先记账并保留，不自动关闭
        t.currentTabId = tab.id;
        t.currentStartedAt = Date.now();
        t.currentRowRetries = (t.currentRowRetries || 0) + 1;
        t.currentRowFailure = '';   // 已重开该行，失效状态清除
        t.resourceBlockDetail = '';
        t.batchFilled = 1;   // 新批次：这一页计入新批次

        if (publishStopBlocked()) {
            t.state = 'paused';
            t.pauseReason = 'manual';
            t.pauseDetail = '重试开页途中收到停止请求：已保留当前页，任务保持暂停';
            await savePublishTask(t);
            stopPublishTick();
            await appendPublishLog({ level: 'retry-stop', row, tabId: tab.id, retries: t.currentRowRetries });
            await broadcastPublishState();
            return { ok: false, message: '已收到停止请求：已保留当前页，任务保持暂停' };
        }

        t.state = 'running';
        t.pauseReason = '';
        t.pauseDetail = '';
        await savePublishTask(t);
        ensurePublishTick();
        await appendPublishLog({ level: 'retry', row, tabId: tab.id, batchOpened: t.batchFilled, retries: t.currentRowRetries });
        await broadcastPublishState();
        return { ok: true, row };
    });
}

async function skipPublishRow() {
    return withPublishLock(async () => {
        const t = await loadPublishTask();
        if (!t) return { ok: false, message: '没有发品任务' };
        if (t.currentRow === null) return { ok: false, message: '当前没有可跳过的行' };
        const row = t.currentRow;
        t.remaining.shift();
        if (!Array.isArray(t.skippedRows)) t.skippedRows = [];
        t.skippedRows.push(row);
        t.currentRow = null;
        t.currentTabId = null;
        t.currentStartedAt = 0;
        t.currentRowRetries = 0;   // 该行已跳过，重试计数归零
        t.currentRowFailure = '';  // 行已被明确跳过，失效状态清除
        t.resourceBlockDetail = '';
        t.state = t.remaining.length === 0 ? 'done' : 'running';
        t.pauseReason = '';
        t.pauseDetail = '';
        await savePublishTask(t);
        await appendPublishLog({ level: 'skip', row, remain: t.remaining.length });
        if (t.state === 'done') {
            stopPublishTick();
        } else {
            ensurePublishTick();
            await processPublishQueueLocked();
        }
        await broadcastPublishState();
        return { ok: true, row, remaining: t.remaining.length };
    });
}

// ---------- 后台冷启动恢复（不把用户暂停变运行） ----------
async function recoverPublishTaskOnStartup() {
    try {
        const t = await loadPublishTask();
        if (publishRunning(t)) {
            ensurePublishTick();
            await publishTickOnce(); // 唤醒后先校验（标签/超时/文件/资源），不直接开页
        }
    } catch (_) {}
}

// alarm 巡检：可唤醒被 MV3 回收的后台
if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm && alarm.name === PUBLISH_TICK_ALARM) publishTickOnce();
    });
}

// 可靠的关页检测（不依赖巡检周期）
chrome.tabs.onRemoved.addListener((tabId) => {
    withColorCompletionLock(async () => {
        const exec = await getActiveColorExec();
        if (!exec || exec.tabId !== tabId || !['pending', 'accepted'].includes(exec.state)) return;
        await saveActiveColorExec({ ...exec, state: 'cancelled', dispatchAllowed: false });
        await savePendingColorTask(null);
        const payload = { rowNum: exec.rowNum, batchId: exec.batchId, executionId: exec.executionId, fileKey: exec.fileKey, timestamp: Date.now() };
        await new Promise(resolve => chrome.storage.local.set({ color_task_stopped_event: payload }, resolve));
        notifyAssistant('colorTaskStopped', payload);
    }).catch(() => {});
    withPublishLock(async () => {
        const t = await loadPublishTask();
        if (!publishRunning(t) || t.currentTabId !== tabId) return;
        await pauseForRowFailureLocked('tabClosed', `第 ${t.currentRow} 行所在标签已被关闭，该行保留在队列`);
    });
});

recoverPublishTaskOnStartup();
recoverColorExecOnStartup();
// 套图：非终态任务在冷启动时标记为中断（不自动重发已提交的豆包请求）
if (typeof SuiteTaskStore !== 'undefined') SuiteTaskStore.recoverOnStartup();

async function realClickCDP(tabId, x, y) {
    let attachedHere = false;
    try {
        try {
            await chrome.debugger.attach({ tabId }, '1.3');
            attachedHere = true;
        } catch (e) {
            if (!e.message.includes('already attached')) {
                throw e;
            }
        }
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x, y,
            button: 'none',
            clickCount: 0
        });
        await new Promise(r => setTimeout(r, 30));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x, y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 60));
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x, y,
            button: 'left',
            clickCount: 1
        });
        await new Promise(r => setTimeout(r, 30));
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (attachedHere) {
            try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        }
    }
}

let doubaoTabId = null;
let pendingColorTask = null;
// 当前换色执行的【持久化身份】：{ batchId, rowNum, source:'batch'|'single', startedAt }
// 派发前写入 storage，冷启动/校验前恢复；不从会被清空的 pendingColorTask 反推
const ACTIVE_COLOR_EXEC_KEY = 'polo_active_color_exec';
let activeColorExec = null;
let colorDispatchStopped = false;
let colorDispatchEpoch = 0;
let colorCompletionLock = Promise.resolve();
function withColorCompletionLock(operation) {
    const next = colorCompletionLock.then(operation);
    colorCompletionLock = next.catch(() => {});
    return next;
}

// 执行绑定的文件标识：下载/缓存/通知一律用它，异步回调不得再读可变的 CURRENT_FILENAME
function boundColorFileInfo(exec) {
    if (!exec || typeof exec.fileKey !== 'string' || typeof exec.fileFolder !== 'string') {
        throw new Error('缺少请求绑定的执行文件身份');
    }
    return Object.freeze({ fileKey: exec.fileKey, fileFolder: exec.fileFolder || DEFAULT_FILE_FOLDER });
}

function sameColorExec(exec, msg, sender) {
    return !!exec && (!sender || sender.frameId === undefined || sender.frameId === 0) && exec.rowNum === msg.rowNum && (exec.batchId || null) === (msg.batchId || null)
        && (!exec.executionId || exec.executionId === msg.executionId)
        && (!sender || !sender.tab || !exec.tabId || exec.tabId === sender.tab.id);
}

async function colorDispatchAllowed(task, tabId) {
    const exec = await getActiveColorExec();
    return !colorDispatchStopped && !!exec && sameColorExec(exec, task) && exec.state === 'pending'
        && exec.dispatchAllowed !== false && exec.fileKey === getFilePrefix()
        && (!exec.tabId || exec.tabId === tabId);
}

async function stopPendingColorDispatch() {
    colorDispatchStopped = true;
    colorDispatchEpoch++;
    return withColorCompletionLock(async () => {
    const exec = await getActiveColorExec();
    if (exec && ['pending', 'accepted'].includes(exec.state)) {
        await saveActiveColorExec({ ...exec, dispatchAllowed: false, state: 'cancelled' });
        await savePendingColorTask(null);
        if (exec.tabId) {
            try { await chrome.tabs.sendMessage(exec.tabId, { action: 'cancelColorTask', executionId: exec.executionId }); } catch (_) {}
        }
    }
    });
}

async function bindPendingColorTab(task, tabId) {
    return withColorCompletionLock(async () => {
        const exec = await getActiveColorExec();
        if (colorDispatchStopped || !sameColorExec(exec, task) || exec.state !== 'pending'
            || exec.dispatchAllowed === false || exec.fileKey !== getFilePrefix()) return false;
        await saveActiveColorExec({ ...exec, tabId });
        return true;
    });
}

async function saveActiveColorExec(exec) {
    activeColorExec = exec || null;
    return new Promise((resolve) => {
        if (exec) chrome.storage.local.set({ [ACTIVE_COLOR_EXEC_KEY]: exec }, resolve);
        else chrome.storage.local.remove(ACTIVE_COLOR_EXEC_KEY, resolve);
    });
}

async function getActiveColorExec() {
    if (activeColorExec) return activeColorExec;
    const r = await new Promise((resolve) => chrome.storage.local.get(ACTIVE_COLOR_EXEC_KEY, resolve));
    activeColorExec = r[ACTIVE_COLOR_EXEC_KEY] || null;
    return activeColorExec;
}

// 冷启动恢复：身份未知时不要静默当成单款任务
async function recoverColorExecOnStartup() {
    try { await getActiveColorExec(); } catch (_) {}
}
const PENDING_AI_EDIT_KEY = 'polo_pending_ai_edit';

async function dispatchPendingAiEdit(tabId) {
    const saved = await new Promise(resolve => chrome.storage.local.get(PENDING_AI_EDIT_KEY, resolve));
    const task = saved[PENDING_AI_EDIT_KEY];
    if (!task || task.tabId !== tabId) return { ok: false, error: '无匹配的改图任务' };
    if (task.fileKey !== getFilePrefix()) {
        await new Promise(resolve => chrome.storage.local.remove(PENDING_AI_EDIT_KEY, resolve));
        return { ok: false, error: '改图任务所属文件已切换' };
    }
    const response = await sendStartAiEditTask(tabId, task);
    if (response.ok || response.busy) {
        const current = await new Promise(resolve => chrome.storage.local.get(PENDING_AI_EDIT_KEY, resolve));
        if (current[PENDING_AI_EDIT_KEY]?.executionId === task.executionId) await new Promise(resolve => chrome.storage.local.remove(PENDING_AI_EDIT_KEY, resolve));
    }
    return response;
}

const IDB_NAME = 'PoloColorImages';
const IDB_STORE = 'images';
const IDB_VERSION = 1;

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveColorImageToIDB(key, dataUrl) {
    try {
        const db = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(dataUrl, key);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    } catch (e) {
        console.warn('IndexedDB 写入失败:', e.message);
        return false;
    }
}

async function getColorImageFromIDB(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => { db.close(); resolve(req.result || null); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    } catch (e) {
        console.warn('IndexedDB 读取失败:', e.message);
        return null;
    }
}

function colorImageIDBKey(filename, rowNum, color) {
    const safeFn = (filename || '').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
    return safeFn + '__row' + rowNum + '__' + color;
}

chrome.storage.local.get([IMAGE_DIR_KEY, COLOR_IMG_DIR_KEY, 'current_filename'], (result) => {
    if (result[IMAGE_DIR_KEY]) IMAGE_DIR = result[IMAGE_DIR_KEY];
    if (result[COLOR_IMG_DIR_KEY]) COLOR_IMG_DIR = result[COLOR_IMG_DIR_KEY];
    if (result['current_filename']) CURRENT_FILENAME = result['current_filename'];
    console.log('📂 启动加载配置:', { IMAGE_DIR, COLOR_IMG_DIR, CURRENT_FILENAME });
});

function getFilePrefix() {
    const prefix = CURRENT_FILENAME ? CURRENT_FILENAME.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_') + '__' : '';
    console.log(`🔍 [getFilePrefix] CURRENT_FILENAME=${CURRENT_FILENAME}, prefix=${prefix}`);
    return prefix;
}

function colorKey(rowNum) {
    return getFilePrefix() + 'color__' + rowNum;
}

function uploadedKey(fileKey) {
    const k = (fileKey === undefined || fileKey === null) ? getFilePrefix() : String(fileKey);
    return k + 'uploaded';
}

function productKey() {
    return getFilePrefix() + 'product';
}



// 生成颜色图本地完整路径：按 COLOR_IMG_DIR/Polo发品_颜色图/{文件名}/rowN/rowN_{颜色}.png 拼接
// （与 downloadDoubaoImage 的落盘目录保持一致）
function buildColorImagePath(rowNum, color, context) {
    let base = context && context.colorImgDir !== undefined ? context.colorImgDir : COLOR_IMG_DIR;
    if (!base) {
        base = 'D:\\下载\\gg';
    }
    const sep = base.includes('/') ? '/' : '\\';
    const dir = base.endsWith('\\') || base.endsWith('/')
        ? base.slice(0, -1)
        : base;
    const hasSubDir = dir.includes('Polo发品_颜色图');
    const fileFolder = context && context.fileFolder !== undefined ? context.fileFolder : (CURRENT_FILENAME || DEFAULT_FILE_FOLDER);
    let path;
    if (hasSubDir) {
        path = dir + sep + fileFolder + sep + 'row' + rowNum + sep + 'row' + rowNum + '_' + color + '.png';
    } else {
        path = dir + sep + 'Polo发品_颜色图' + sep + fileFolder + sep + 'row' + rowNum + sep + 'row' + rowNum + '_' + color + '.png';
    }
    console.log(`🔍 [buildColorImagePath] 生成路径: ${path}, base=${base}, hasSubDir=${hasSubDir}, fileFolder=${fileFolder}`);
    return path;
}

// 读取某行某颜色的颜色图数据：优先当前文件键，其次 legacy 键（迁移后删除），
// 返回 { url, path }（data URL 或本地路径），供发品页上传颜色图
function getColorImagePathData(rowNum, color, callback, context) {
    context = context || { fileKey: getFilePrefix(), fileFolder: CURRENT_FILENAME || DEFAULT_FILE_FOLDER, colorImgDir: COLOR_IMG_DIR };
    const storageKey = context.fileKey + 'color__' + rowNum;
    const boundImageDir = context.colorImgDir;
    console.log(`🔍 [getColorImagePathData] row=${rowNum}, color=${color}, COLOR_IMG_DIR=${COLOR_IMG_DIR}, CURRENT_FILENAME=${CURRENT_FILENAME}, storageKey=${storageKey}`);
    chrome.storage.local.get(storageKey, (result) => {
        let images = result[storageKey] || {};
        if (Object.keys(images).length === 0) {
            const legacyKey = 'color_images_row_' + rowNum;
            chrome.storage.local.get(legacyKey, (legacyResult) => {
                const legacyImages = context.taskId || context.fileKey ? {} : (legacyResult[legacyKey] || {});
                if (Object.keys(legacyImages).length > 0) {
                    chrome.storage.local.set({ [storageKey]: legacyImages }, () => {
                        chrome.storage.local.remove(legacyKey);
                        console.log(`🔄 已迁移颜色图数据: ${legacyKey} → ${storageKey}`);
                    });
                    images = legacyImages;
                }
                const imgData = images[color];
                const url = typeof imgData === 'string' ? imgData : (imgData?.url || null);
                let path = null;
                if (boundImageDir) {
                    path = buildColorImagePath(rowNum, color, context);
                    console.log(`🔍 [getColorImagePathData] storage空，用COLOR_IMG_DIR拼路径: ${path}`);
                } else {
                    path = typeof imgData === 'string' ? null : (imgData?.path || null);
                    console.log(`🔍 [getColorImagePathData] storage空，COLOR_IMG_DIR也空，path=${path}`);
                }
                const resultData = { ok: true, path, url };
                console.log(`🔍 [getColorImagePathData] 准备调用callback: ${JSON.stringify(resultData)}`);
                try {
                    callback(resultData);
                    console.log(`✅ [getColorImagePathData] callback调用成功`);
                } catch (e) {
                    console.error(`❌ [getColorImagePathData] callback调用失败: ${e.message}`);
                }
            });
        } else {
            try {
                const imgData = images[color];
                console.log(`🔍 [getColorImagePathData] imgData类型: ${typeof imgData}, 值: ${JSON.stringify(imgData)}`);
                const url = typeof imgData === 'string' ? imgData : (imgData?.url || null);
                console.log(`🔍 [getColorImagePathData] url: ${url}`);
                let path = null;
                if (boundImageDir) {
                    path = buildColorImagePath(rowNum, color, context);
                    console.log(`🔍 [getColorImagePathData] storage有数据，用COLOR_IMG_DIR拼路径: ${path}`);
                } else {
                    path = typeof imgData === 'string' ? null : (imgData?.path || null);
                    console.log(`🔍 [getColorImagePathData] storage有数据但COLOR_IMG_DIR空，path=${path}`);
                }
                const resultData = { ok: true, path, url };
                console.log(`🔍 [getColorImagePathData] 准备调用callback: ${JSON.stringify(resultData)}`);
                callback(resultData);
                console.log(`✅ [getColorImagePathData] callback调用成功`);
            } catch (e) {
                console.error(`❌ [getColorImagePathData] storage有数据分支异常: ${e.message}`);
                console.error(e.stack);
                callback({ ok: false, error: e.message });
            }
        }
    });
}

chrome.runtime.onInstalled.addListener(() => {
    console.log('✅ Polo发品助手扩展已安装 / 更新 / 重载');
    // 打时间戳：供「发品助手」页检测扩展重载并自动刷新
    // （SW 被回收不会触发本事件，所以不会误刷新页面、不会丢批量进度）
    chrome.storage.local.set({ polo_ext_reload_ts: Date.now() });
    ensureConfigLoaded().then(() => {
        console.log('📂 启动配置已加载:', { IMAGE_DIR, COLOR_IMG_DIR, CURRENT_FILENAME });
    });
});

chrome.runtime.onStartup.addListener(() => {
    ensureConfigLoaded();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && (tab.url.includes('doubao.com') || tab.url.includes('www.doubao.com'))) {
        console.log('🌐 豆包页面加载完成:', tabId);
        doubaoTabId = tabId;
        await saveDoubaoTabId(tabId);
        dispatchPendingAiEdit(tabId).catch(e => console.warn('改图任务接收失败:', e.message));
        
        const pendingTask = await getPendingColorTask();
        if (pendingTask) {
            console.log('📤 发送待处理的换色任务（从storage恢复）');
            setTimeout(async () => {
                // 补发也必须核对接收结果：未确认接收就保留待派发记录（不能凭加载事件绕过）
                if (!await colorDispatchAllowed(pendingTask, tabId)) return;
                const resp = await sendStartColorTask(tabId, pendingTask);
                if (resp && resp.ok) {
                    await withColorCompletionLock(async () => {
                    const exec = await getActiveColorExec();
                    if (exec && (exec.batchId || null) === ((typeof pendingTask.batchId === 'string' && pendingTask.batchId) ? pendingTask.batchId : null)
                        && exec.rowNum === pendingTask.rowNum && (!exec.executionId || exec.executionId === pendingTask.executionId)
                        && ['pending', 'accepted'].includes(exec.state) && exec.dispatchAllowed !== false
                        && !(exec.state === 'pending' && colorDispatchStopped)) {
                        await savePendingColorTask(null);
                        await saveActiveColorExec(Object.assign({}, exec, { state: 'accepted', acceptedAt: Date.now(), tabId }));
                    }
                    });
                    console.log('✅ 补发已确认接收');
                } else {
                    console.warn('⚠️ 补发未被接收（保留待派发记录）:', (resp && resp.error) || '无响应');
                }
            }, 2000);
        }
    }
});

// 共享动作分发器：处理 onMessage/onMessageExternal 的 17 种业务动作
// （saveProductData/saveBatchProducts/getProductByRow/openPublishPage/…/getConfig），
// 各动作内直接操作 storage 与目录配置并 sendResponse
async function handleSharedAction(request, sendResponse, sender) {
    // ---------- 发品任务控制（发品助手页 file:// 与扩展内部均可） ----------
    if (request.action === 'pausePublishQueue') {
        markPublishStop();   // 立即置闸门并递增停止代次：资源检查/开页途中也不再创建新页
        pausePublishTask('manual', '用户手动停止').then(() => {
            buildPublishStatePayload().then(p => sendResponse({ ok: true, state: p.state }));
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'resumePublishQueue') {
        resumePublishTask().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'getPublishState') {
        buildPublishStatePayload().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'setPublishSettings') {
        setPublishSettings(request.patch || {}).then(s => sendResponse({ ok: true, settings: s })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'getDiagLog') {
        chrome.storage.local.get(PUBLISH_LOG_KEY, r => sendResponse({ ok: true, log: r[PUBLISH_LOG_KEY] || [] }));
        return true;
    }
    if (request.action === 'clearDiagLog') {
        chrome.storage.local.remove(PUBLISH_LOG_KEY, () => sendResponse({ ok: true }));
        return true;
    }
    if (request.action === 'getColorTaskEvents') {
        const events = await new Promise(resolve => chrome.storage.local.get(['color_task_complete_event', 'color_task_accepted_event', 'color_task_stopped_event'], resolve));
        sendResponse({ ok: true, events });
        return true;
    }
    if (request.action === 'pauseColorDispatch') {
        await stopPendingColorDispatch();
        sendResponse({ ok: true });
        return true;
    }
    // 接收确认只来自已绑定的豆包执行页。
    if (request.action === 'colorTaskAccepted') {
        await withColorCompletionLock(async () => {
        const exec = await getActiveColorExec();
        const tabId = sender && sender.tab && sender.tab.id;
        if (!tabId || !sameColorExec(exec, request, sender) || !exec
            || !['pending', 'accepted'].includes(exec.state) || (exec.state === 'pending' && colorDispatchStopped) || exec.dispatchAllowed === false
            || (exec.state === 'pending' && exec.fileKey !== getFilePrefix())) {
            sendResponse({ ok: false, error: '执行身份或派发许可已失效' });
            return true;
        }
        const accepted = { ...exec, state: 'accepted', tabId, acceptedAt: Date.now() };
        await saveActiveColorExec(accepted);
        await savePendingColorTask(null);
        const payload = { rowNum: exec.rowNum, batchId: exec.batchId, executionId: exec.executionId,
            fileKey: exec.fileKey, timestamp: Date.now() };
        await new Promise(resolve => chrome.storage.local.set({ color_task_accepted_event: payload }, resolve));
        notifyAssistant('colorTaskAccepted', payload);
        sendResponse({ ok: true });
        });
        return true;
    }
    // 查询当前换色执行身份与豆包执行状态（供页面做超时后的明确处理动作）
    if (request.action === 'getColorExecStatus') {
        (async () => {
            let engine = null;
            let engineKnown = false;
            const exec = await getActiveColorExec();
            try {
                // 绑定执行页：优先用执行身份记录的 tabId，避免多张豆包页时查到空闲页
                let tabId = exec && exec.tabId ? exec.tabId : null;
                if (tabId) {
                    try { await chrome.tabs.get(tabId); } catch (_) { tabId = null; }
                }

                if (tabId) {
                    engine = await chrome.tabs.sendMessage(tabId, { action: 'getColorTaskStatus' });
                    engineKnown = !!(engine && engine.ok === true && typeof engine.isProcessing === 'boolean');
                    // 引擎回传的任务与执行身份核对；不符则按未知处理（不能拿别的任务的状态当依据）
                    if (engineKnown && exec) {
                        const et = engine.task || null;
                        const etRow = et && et.rowNum;
                        const etBatch = (et && typeof et.batchId === 'string' && et.batchId) ? et.batchId : null;
                        if (!et || etRow !== exec.rowNum || (exec.executionId && et.executionId !== exec.executionId)) {
                            console.warn(`⚠️ 引擎任务与执行身份不符（engine row${etRow} / exec row${exec.rowNum}），按未知处理`);
                            engineKnown = false;
                        } else if (etBatch !== (exec.batchId || null)) {
                            console.warn(`⚠️ 引擎任务标识与执行身份不符（engine ${etBatch} / exec ${exec.batchId || '(单款)'}），按未知处理`);
                            engineKnown = false;
                        }
                    }
                }
            } catch (e) { engine = { ok: false, error: e.message }; engineKnown = false; }
            sendResponse({
                ok: true,
                exec,
                engine: engine || { ok: false, error: '未找到豆包页面' },
                engineKnown,
                queriedAt: Date.now()
            });
        })();
        return true;
    }
    if (request.action === 'clearColorExec') {
        const exec = await getActiveColorExec();
        if (exec && ((exec.executionId && exec.executionId !== request.executionId)
            || (request.rowNum !== undefined && exec.rowNum !== request.rowNum)
            || (request.fileKey !== undefined && exec.fileKey !== request.fileKey)
            || (request.batchId !== undefined && (exec.batchId || null) !== request.batchId))) { sendResponse({ ok: false, error: '执行已变化，未清除新任务' }); return true; }
        await saveActiveColorExec(null);
        await savePendingColorTask(null);
        sendResponse({ ok: true });
        return true;
    }
    /* ================= 套图（快速五图）任务：suite 命名空间 =================
       与 color 任务完全隔离：独立存储键、独立动作名、独立阶段机。
       豆包标签/输入通道两者共用 → 建立互斥，避免同时上传与输入。 */
    if (request.action === 'suiteCreate') {
        (async () => {
            try {
                // 互斥：换色任务仍在执行时不允许并发占用豆包输入通道
                const cexec = await getActiveColorExec();
                if (cexec && cexec.state === 'accepted') {
                    sendResponse({ ok: false, error: '换色任务正在执行，请等它结束后再发起套图（两者共用豆包输入通道）' });
                    return;
                }
                const t = await SuiteTaskStore.create(request.task || {});
                sendResponse({ ok: true, task: t, stage: t.stage });
            } catch (e) { sendResponse({ ok: false, error: e.message }); }
        })();
        return true;
    }
    if (request.action === 'suiteGetTask') {
        SuiteTaskStore.get(request.taskId).then(t => sendResponse({ ok: true, task: t })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'suiteListTasks') {
        SuiteTaskStore.list({ fileKey: request.fileKey, rowNum: request.rowNum, activeOnly: !!request.activeOnly })
            .then(list => sendResponse({ ok: true, tasks: list })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'suiteCancel') {
        SuiteTaskStore.cancel(request.taskId, request.reason)
            .then(t => sendResponse({ ok: true, task: t })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    // 进度/结果回传：先做身份核验（拒绝旧任务、其他产品、已取消、阶段倒退）
    if (request.action === 'suiteProgress') {
        (async () => {
            try {
                const check = await SuiteTaskStore.acceptReport(request.report || {});
                if (!check.accepted) { sendResponse({ ok: false, rejected: true, error: check.reason }); return; }
                const r = request.report || {};
                let task;
                if (r.final && r.finalStage) {
                    task = await SuiteTaskStore.finish(r.taskId, r.finalStage, r.error || '', { results: r.results || check.task.results, diag: r.diag || check.task.diag });
                } else if (r.stage) {
                    task = await SuiteTaskStore.advance(r.taskId, r.stage, { results: r.results || check.task.results, diag: r.diag || check.task.diag });
                } else {
                    sendResponse({ ok: false, error: '缺少 stage 或 finalStage' });
                    return;
                }
                sendResponse({ ok: true, task });
            } catch (e) { sendResponse({ ok: false, error: e.message }); }
        })();
        return true;
    }
    if (request.action === 'suiteRecover') {
        SuiteTaskStore.recoverOnStartup().then(ids => sendResponse({ ok: true, interrupted: ids })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    /* 套图执行编排：把已创建任务真正送入豆包执行（一次快速五图，不拆分）
       步骤：互斥检查 → 取/建豆包页 → 探测就绪 → 记基线 → 上传素材 →
             输入合并提示词 → 明确发送一次 → 等待本次新结果 → 交页面识别/后处理/保存 */
    if (request.action === 'suiteRun') {
        (async () => {
            const taskId = request.taskId;
            const report = (stage, extra) => chrome.runtime.sendMessage(EXTENSION_ID,
                Object.assign({ action: 'suiteProgress', report: Object.assign({ taskId, stage }, extra || {}) }, {})).catch(() => {});
            try {
                const t = await SuiteTaskStore.get(taskId);
                if (!t) { sendResponse({ ok: false, error: '未知任务：' + taskId }); return; }
                if (SuiteTaskStore.isTerminal(t.stage)) { sendResponse({ ok: false, error: `任务已终态：${t.stage}` }); return; }

                // 双向互斥①：换色正在执行 → 抢占失败，明确失败而不是排队等待
                const cexec = await getActiveColorExec();
                if (cexec && cexec.state === 'accepted') {
                    await SuiteTaskStore.fail(taskId, '阶段 channel：换色任务正在执行，套图无法占用豆包输入通道');
                    sendResponse({ ok: false, error: '换色任务正在执行，套图无法占用豆包输入通道' });
                    return;
                }
                // 取得套图执行锁（换色启动前会检查它）
                await saveActiveColorExec(null).catch(() => {});
                globalThis.__suiteExecLock = { taskId, at: Date.now() };

                let tab = await findDoubaoTab();
                if (!tab) {
                    tab = await chrome.tabs.create({ url: DOUBAO_URL, active: true });
                    await new Promise(r => setTimeout(r, 4000));
                }
                const tabId = tab.id;
                const toTab = (action, payload) => chrome.tabs.sendMessage(tabId, Object.assign({ action }, payload || {}));

                // ① 探测就绪 / 登录
                const pr = await toTab('suite-probe');
                if (!pr || !pr.success) throw new Error('豆包页面未就绪：' + ((pr && pr.error) || '无响应'));
                if (pr.loggedOut) throw new Error('豆包登录失效，请先登录后再发起套图');
                if (!pr.hasInput) throw new Error('豆包输入框未出现，页面结构可能已变化');

                // ② 基线（发送前已有图片）
                const bl = await toTab('suite-baseline', { binding: { taskId, fileKey: t.fileKey, rowNum: t.rowNum } });
                if (!bl || !bl.success) throw new Error('记录图片基线失败');
                await SuiteTaskStore.advance(taskId, 'sent', { diag: [`基线 ${bl.baselineUrls.length} 张`] }).catch(() => {});

                // ③ 上传素材（执行器内部实际等待上传完成）
                const assets = (t.assets && t.assets.length) ? t.assets : ((t.configSnapshot && t.configSnapshot.assets) || []);
                if (!assets.length) throw new Error('任务快照中没有素材');
                for (const a of assets) { if (!a || !a.url) throw new Error('素材项缺少 url：' + JSON.stringify(a)); }
                const up = await toTab('suite-upload', { assets });
                if (!up || !up.success) throw new Error('上传失败：' + ((up && up.error) || '未知'));

                // ④ 输入合并提示词（原生桥；换行 Shift+Enter，输入阶段不提交）
                const promptText = t.prompt;
                if (!promptText || !promptText.trim()) throw new Error('任务缺少合并提示词正文');
                const ty = await toTab('suite-type', { text: promptText });
                if (!ty || !ty.success) throw new Error('提示词输入失败：' + ((ty && ty.error) || '未知'));

                // ⑤ 明确发送一次（执行器内部防止重复发送）
                const sd = await toTab('suite-send');
                if (!sd || !sd.success) throw new Error('发送失败：' + ((sd && sd.error) || '未知'));
                await SuiteTaskStore.advance(taskId, 'sent', { diag: [`已发送，基线 ${(sd.baselineUrls || []).length} 张，证据 ${sd.evidence || '-'}`] }).catch(() => {});

                // ⑥ 等待并采集本次新结果
                const wt = await toTab('suite-wait', { baselineUrls: sd.baselineUrls || bl.baselineUrls, expectCount: t.expectCount || 5, timeoutMs: 600000 });
                if (!wt || !wt.success) throw new Error('等待结果失败：' + ((wt && wt.error) || '未知'));
                const r = wt.result || {};
                if (!r.images || r.images.length < (t.expectCount || 5)) {
                    await SuiteTaskStore.fail(taskId, `结果不足：期望 ${t.expectCount || 5} 张，实际 ${(r.images || []).length} 张（原始 ${r.rawCount || 0}，同图归并 ${r.mergedGroups || 0} 组）`);
                    sendResponse({ ok: false, error: `结果不足：${(r.images || []).length}/${t.expectCount || 5}` });
                    return;
                }
                await SuiteTaskStore.advance(taskId, 'acquired', { images: r.images, diag: [`获取 ${r.images.length} 张（原始 ${r.rawCount}，归并 ${r.mergedGroups} 组，基线 ${r.baselineCount}）`] }).catch(() => {});
                sendResponse({ ok: true, taskId, stage: 'acquired', images: r.images, baselineUrls: sd.baselineUrls || bl.baselineUrls });
            } catch (e) {
                await SuiteTaskStore.fail(taskId, '执行阶段：' + (e && e.message)).catch(() => {});
                sendResponse({ ok: false, error: e && e.message });
            } finally {
                globalThis.__suiteExecLock = null;
            }
        })();
        return true;
    }
    // 兼容尚未刷新的助手页：内存保护已按用户要求移除，不发起监测请求。
    if (request.action === 'getMemoryGate') {        sendResponse({ ok: true, allowed: true, disabled: true, reasons: [], reasonText: '' });
        return true;
    }
    if (request.action === 'retryPublishRow') {
        retryPublishRow().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'skipPublishRow') {
        skipPublishRow().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'saveProductData') {
        const pKey = productKey();
        const boundData = { ...request.data, _publishFileKey: getFilePrefix() };
        const setObj = { [pKey]: boundData };
        setObj[STORAGE_KEY] = boundData;
        chrome.storage.local.set(setObj, () => {
            sendResponse({ ok: true });
        });
        if (request.imageDir) {
            if (!isValidDir(request.imageDir)) {
                console.warn('⛔ 非法图片目录，忽略:', request.imageDir);
            } else {
                IMAGE_DIR = request.imageDir;
                chrome.storage.local.set({ [IMAGE_DIR_KEY]: request.imageDir });
                console.log('📂 图片目录已更新:', request.imageDir);
            }
        }
        if (request.colorImgDir && !COLOR_IMG_DIR) {
            if (!isValidDir(request.colorImgDir)) {
                console.warn('⛔ 非法颜色图目录，忽略:', request.colorImgDir);
            } else {
                COLOR_IMG_DIR = request.colorImgDir;
                chrome.storage.local.set({ [COLOR_IMG_DIR_KEY]: request.colorImgDir });
                console.log('🖼️ 颜色图目录已初始化（来自页1）:', request.colorImgDir);
            }
        } else if (request.colorImgDir && COLOR_IMG_DIR) {
            console.log('🖼️ 颜色图目录已由popup设置，忽略页1传入值。当前:', COLOR_IMG_DIR, '，页1传入:', request.colorImgDir);
        } else if (IMAGE_DIR && !COLOR_IMG_DIR) {
            const baseDir = IMAGE_DIR.replace(/[/\\]extracted_images$/, '');
            if (baseDir && baseDir !== IMAGE_DIR) {
                COLOR_IMG_DIR = baseDir;
                chrome.storage.local.set({ [COLOR_IMG_DIR_KEY]: baseDir });
                console.log('🖼️ 颜色图目录已自动设置:', baseDir);
            }
        }
        return true;
    }
    if (request.action === 'saveBatchProducts') {
        const result = await withPublishLock(async () => {
        const task = await loadPublishTask();
        if (task && task.remaining.length && (task.state === 'running' || task.state === 'paused')) {
            return { ok: false, error: '存在未完成发品任务，未覆盖原产品数据' };
        }
        const products = request.products || [];
        const setObj = {};
        const prefix = getFilePrefix();
        for (const p of products) {
            if (p && p.row !== undefined) {
                const key = prefix + 'product__row' + p.row;
                setObj[key] = p;
            }
        }
        if (request.imageDir) {
            if (!isValidDir(request.imageDir)) {
                console.warn('⛔ 非法图片目录，忽略:', request.imageDir);
            } else {
                IMAGE_DIR = request.imageDir;
                setObj[IMAGE_DIR_KEY] = request.imageDir;
                console.log('📂 图片目录已更新:', request.imageDir);
            }
        }
        if (request.colorImgDir && !COLOR_IMG_DIR) {
            if (!isValidDir(request.colorImgDir)) {
                console.warn('⛔ 非法颜色图目录，忽略:', request.colorImgDir);
            } else {
                COLOR_IMG_DIR = request.colorImgDir;
                setObj[COLOR_IMG_DIR_KEY] = request.colorImgDir;
                console.log('🖼️ 颜色图目录已初始化（来自批量发品）:', request.colorImgDir);
            }
        } else if (request.colorImgDir && COLOR_IMG_DIR) {
            console.log('🖼️ 颜色图目录已由popup设置，忽略批量发品传入值。当前:', COLOR_IMG_DIR, '，批量传入:', request.colorImgDir);
        }
        await new Promise(resolve => chrome.storage.local.set(setObj, resolve));
        return { ok: true, count: products.length };
        });
        sendResponse(result);
        return true;
    }
    if (request.action === 'getProductByRow') {
        const rowNum = request.rowNum;
        const finish = (prefix, flags = {}) => {
            const key = prefix + 'product__row' + rowNum;
            chrome.storage.local.get(key, (result) => {
                const product = result[key] || null;
                if (product) {
                    console.log(`📦 获取产品数据: row=${rowNum}, title=${product.seo_title_en || product.title_en || '无标题'}`);
                } else {
                    console.log(`⚠️ 未找到产品数据: row=${rowNum}`);
                }
                sendResponse({ ok: !!product, data: product ? { ...product, _publishFileKey: prefix } : null, ...flags });
            });
        };
        const hasTaskId = (request.taskId !== undefined && request.taskId !== null && request.taskId !== '');
        if (hasTaskId) {
            // taskId 已提供：必须匹配存在的任务，且按任务绑定文件读取；不匹配一律拒绝（不回退当前文件）
            loadPublishTask().then(async t => {
                if (!t || t.taskId !== request.taskId) {
                    console.warn(`⛔ getProductByRow 任务标识不匹配（请求 ${request.taskId}），已拒绝，不回退当前文件`);
                    sendResponse({ ok: false, error: '任务标识不匹配，已拒绝（不回退当前文件）' });
                    return;
                }
                // 已填入与已保存是独立状态：完成一轮后待保存，刷新不重复填入。
                const alreadyFilled = (t.filledRows || []).some(row => Number(row) === Number(rowNum));
                const saved = await getVerifiedSavedMap(taskFileKey(t));
                const autoFillAllowed = !saved[rowNum] && !alreadyFilled
                    && Number(t.currentRow) === Number(rowNum) && !!sender.tab && sender.tab.id === t.currentTabId;
                if (t.products && Object.prototype.hasOwnProperty.call(t.products, String(rowNum))) {
                    const data = t.products[String(rowNum)];
                    sendResponse({ ok: !!data, autoFillAllowed, data: data ? { ...data, _publishTaskId: t.taskId, _publishFileKey: taskFileKey(t), _publishImageDir: t.imageDir } : null });
                } else if (!t.products) {
                    // 兼容已存在的旧任务；未完成任务期间存储写入已被拒绝。
                    finish(taskFileKey(t), { autoFillAllowed });
                } else sendResponse({ ok: false, error: '该行不属于任务产品快照' });
            });
        } else {
            finish(getFilePrefix());
        }
        return true;
    }
    if (request.action === 'openPublishPage') {
        chrome.tabs.create({
            url: 'https://post.alibaba.com/product/easyListing.htm?spm=a2700.micro_product_manager.0.0.40e03e5fPaTwSu'
        });
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === 'openBatchPublish') {
        const epochAtRequest = publishStopEpoch;
        const rows = request.rows || [];
        if (rows.length === 0) {
            sendResponse({ ok: true, count: 0 });
            return true;
        }

        // 任务存在检查 + 创建必须在同一串行段内：并发请求只允许一次成功
        const result = await withPublishLock(async () => {
            const prev = await loadPublishTask();
            if (prev && prev.state === 'running') {
                return { ok: false, error: '已有正在进行的发品任务，已保留原队列；请先停止或等其结束' };
            }
            if (prev && prev.state === 'paused' && prev.remaining.length > 0) {
                return { ok: false, error: `存在暂停中的任务（剩 ${prev.remaining.length} 款）。请先点「继续下一批」` };
            }

            if (publishStoppedSince(epochAtRequest)) return { ok: false, error: '等待创建期间收到停止请求，未创建任务' };
            const fileKey = getFilePrefix();
            if (request.fileKey !== undefined && request.fileKey !== fileKey) {
                return { ok: false, error: 'Excel 文件已切换，未创建任务' };
            }
            const data = Array.isArray(request.products) ? request.products : null;
            let snapshot = {};
            if (data) {
                for (const p of data) if (p && rows.includes(p.row)) snapshot[String(p.row)] = p;
                if (rows.some(row => !snapshot[String(row)])) return { ok: false, error: '任务产品数据不完整，未创建任务' };
            } else {
                const keys = rows.map(row => fileKey + 'product__row' + row);
                const stored = await new Promise(resolve => chrome.storage.local.get(keys, resolve));
                for (const row of rows) snapshot[String(row)] = stored[fileKey + 'product__row' + row] || null;
            }
            const s = await getPublishSettings();
            const now = Date.now();
            const task = {
                taskId: 'pt_' + now + '_' + Math.random().toString(36).slice(2, 8),
                fileKey,
                products: snapshot,
                imageDir: request.imageDir || IMAGE_DIR,
                colorImgDir: COLOR_IMG_DIR || request.colorImgDir || '',
                fileFolder: CURRENT_FILENAME || DEFAULT_FILE_FOLDER,
                total: rows.length,
                remaining: [...rows],
                filledCount: 0,
                filledRows: [],
                batchSize: s.batchSize,
                batchFilled: 0,
                batchFilledDone: 0,
                pageLimit: s.pageLimit,
                rowTimeoutMs: s.rowTimeoutMs,
                state: 'running',
                pauseReason: '',
                pauseDetail: '',
                currentRow: null,
                currentTabId: null,
                currentStartedAt: 0,
                currentRowRetries: 0,
                currentRowFailure: '',
                resourceBlockDetail: '',
                startedAt: now
            };
            if (request.imageDir && isValidDir(request.imageDir)) IMAGE_DIR = request.imageDir;
            if (request.colorImgDir && isValidDir(request.colorImgDir) && !COLOR_IMG_DIR) COLOR_IMG_DIR = request.colorImgDir;
            await new Promise(resolve => chrome.storage.local.set({ [IMAGE_DIR_KEY]: IMAGE_DIR, [COLOR_IMG_DIR_KEY]: COLOR_IMG_DIR }, resolve));
            await savePublishTask(task);
            if (publishStoppedSince(epochAtRequest)) {
                task.state = 'paused'; task.pauseReason = 'manual'; task.pauseDetail = '创建期间收到停止请求';
                await savePublishTask(task); await broadcastPublishState();
                return { ok: true, count: rows.length, taskId: task.taskId, batchSize: 50 };
            }
            beginPublishRunIntentFrom(epochAtRequest);
            console.log(`📋 发品任务已创建 ${task.taskId}，共 ${task.total} 款，批次 ${task.batchSize}`);
            await appendPublishLog({ level: 'create', taskId: task.taskId, total: task.total, batchSize: task.batchSize, fileKey: task.fileKey });

            await processPublishQueueLocked();   // 锁内调用，避免把带锁函数嵌套进锁
            return { ok: true, count: rows.length, taskId: task.taskId, batchSize: task.batchSize };
        });

        await broadcastPublishState();
        sendResponse(result);
        return true;
    }
    if (request.action === 'publishCompleted') {
        // 已废弃：旧事件不得无条件推进队列
        console.log(`ℹ️ 收到已废弃的 publishCompleted（row ${request.rowNum}），未推进队列`);
        await appendPublishLog({ level: 'deprecated', event: 'publishCompleted', row: request.rowNum });
        sendResponse({ ok: true, deprecated: true });
        return true;
    }
    if (request.action === 'markUploaded') {
        // 已废弃并拒绝：禁止外部页面伪造「已保存」
        console.warn(`⛔ markUploaded 已废弃并拒绝（row ${request.row}）`);
        await appendPublishLog({ level: 'reject', event: 'markUploaded', row: request.row });
        sendResponse({ ok: false, error: 'markUploaded 已废弃：请使用页3保存菜单记账' });
        return true;
    }
    if (request.action === 'getUploadedRows') {
        const t = await loadPublishTask();
        const hasTaskId = (request.taskId !== undefined && request.taskId !== null && request.taskId !== '');
        // 页2/页3 带 taskId → 按任务绑定文件查询；助手页列表不带 → 按当前文件查询
        let fileKey;
        if (hasTaskId) {
            if (!t || t.taskId !== request.taskId) {
                sendResponse({ ok: false, error: '任务标识不匹配，已拒绝' });
                return true;
            }
            fileKey = taskFileKey(t);
        } else {
            fileKey = typeof request.fileKey === 'string' ? request.fileKey : getFilePrefix();
        }
        const verified = await getVerifiedSavedMap(fileKey);
        const legacyKey = uploadedKey(fileKey);
        const legacy = await new Promise(r => chrome.storage.local.get(legacyKey, v => r(v[legacyKey] || {})));
        sendResponse({ ok: true, rows: verified, legacy, fileKey });
        return true;
    }
    if (request.action === 'startColorChange') {
        openDoubaoAndStartTask(request.task).then(result => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === 'startAiEdit') {
        openDoubaoForAiEdit(request.task).then(result => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === 'startPsEdit') {
        startPsEdit(request.task).then(result => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === 'getColorImage') {
        fetchColorImageAsBase64(request.rowNum, request.color, request.fileKey).then(result => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === 'getColorImagesInfo') {
        const storageKey = colorKey(request.rowNum);
        chrome.storage.local.get(storageKey, (result) => {
            let images = result[storageKey] || {};
            if (Object.keys(images).length === 0 && storageKey === 'color__' + request.rowNum) {
                const legacyKey = 'color_images_row_' + request.rowNum;
                chrome.storage.local.get(legacyKey, (legacyResult) => {
                    const legacyImages = legacyResult[legacyKey] || {};
                    if (Object.keys(legacyImages).length > 0) {
                        chrome.storage.local.set({ [storageKey]: legacyImages }, () => {
                            chrome.storage.local.remove(legacyKey);
                            console.log(`🔄 已迁移颜色图数据: ${legacyKey} → ${storageKey}`);
                        });
                        images = legacyImages;
                    }
                    sendResponse({ ok: true, images: Object.keys(images) });
                });
            } else {
                sendResponse({ ok: true, images: Object.keys(images) });
            }
        });
        return true;
    }
    if (request.action === 'getColorImagePath') {
        if (request.taskId) {
            const task = await loadPublishTask();
            if (!task || task.taskId !== request.taskId || (task.products ? !Object.prototype.hasOwnProperty.call(task.products, String(request.rowNum)) : ![...task.remaining, ...(task.filledRows || [])].includes(request.rowNum))) {
                sendResponse({ ok: false, error: '发品图片任务身份不匹配' }); return true;
            }
            if (task.colorImgDir === undefined && task.fileKey !== getFilePrefix()) { sendResponse({ ok: false, error: '旧任务缺少图片目录绑定，请切回原 Excel' }); return true; }
            getColorImagePathData(request.rowNum, request.color, sendResponse, {
                taskId: task.taskId, fileKey: task.fileKey, fileFolder: task.fileFolder === undefined ? (CURRENT_FILENAME || DEFAULT_FILE_FOLDER) : task.fileFolder,
                colorImgDir: task.colorImgDir === undefined ? COLOR_IMG_DIR : task.colorImgDir
            });
            return true;
        }
        console.log(`🔍 [getColorImagePath] 调用: rowNum=${request.rowNum}, color=${request.color}, COLOR_IMG_DIR=${COLOR_IMG_DIR}, CURRENT_FILENAME=${CURRENT_FILENAME}`);
        const responseFn = (data) => {
            console.log(`🔍 [getColorImagePath] 收到getColorImagePathData回调，原始data: ${JSON.stringify(data)}`);
            data._debug = { colorImgDir: COLOR_IMG_DIR, currentFilename: CURRENT_FILENAME };
            console.log(`🔍 [getColorImagePath] 返回数据: ${JSON.stringify(data)}`);
            try {
                sendResponse(data);
                console.log(`✅ [getColorImagePath] sendResponse调用成功`);
            } catch (e) {
                console.error(`❌ [getColorImagePath] sendResponse调用失败: ${e.message}`);
            }
        };
        getColorImagePathData(request.rowNum, request.color, responseFn);
        return true;
    }
    if (request.action === 'setCurrentFilename') {
        const nextName = request.filename || '';
        if (nextName === CURRENT_FILENAME) {
            // 同名同步：不无理由暂停任务
            sendResponse({ ok: true, filename: CURRENT_FILENAME, unchanged: true });
            return true;
        }
        colorDispatchStopped = true;
        colorDispatchEpoch++;
        markPublishStop();
        // 先真正完成暂停（等锁释放）再切换当前文件，避免暂停与切换竞态
        pausePublishTask('fileSwitch', '用户切换了当前 Excel 文件，任务已暂停').then(async () => {
            const prevName = CURRENT_FILENAME;
            await stopPendingColorDispatch();
            CURRENT_FILENAME = nextName;
            console.log(`📄 当前文件名切换为: ${CURRENT_FILENAME || '(默认)'}`);
            // 通知助手页暂停换色批次（保留在途结果，不取消、不关页）
            notifyAssistant('colorFileSwitched', { from: prevName, to: CURRENT_FILENAME });
            chrome.storage.local.set({ current_filename: CURRENT_FILENAME }, () => {
                sendResponse({ ok: true, filename: CURRENT_FILENAME });
            });
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'getPsEditResult') {
        chrome.storage.local.get(PS_EDIT_RESULT_KEY, (result) => {
            sendResponse({ ok: true, result: result[PS_EDIT_RESULT_KEY] || null });
        });
        return true;
    }
    if (request.action === 'clearPsEditResult') {
        chrome.storage.local.remove(PS_EDIT_RESULT_KEY, () => {
            sendResponse({ ok: true });
        });
        return true;
    }
    return false;
}

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    // H1 第1层：先校验来源，不通过则拒绝（外层 return true 保持异步通道）
    isTrustedSender(sender).then((ok) => {
        if (!ok) {
            console.warn(`⛔ [onMessageExternal] 拒绝未授权外部消息: action=${request.action}, senderUrl=${sender?.url || 'unknown'}`);
            sendResponse({ ok: false, error: '未授权来源' });
            return;
        }
        console.log(`🔍 [onMessageExternal] 收到消息: action=${request.action}, senderUrl=${sender?.url || 'unknown'}, senderId=${sender?.id || 'unknown'}`);
        if (request.action === 'ping') {
            assistantTabId = sender.tab?.id || null;
            sendResponse({ ok: true, version: '1.0.0' });
            return true;
        }
        if (request.action === 'clearAllColorImages') {
            const prefix = getFilePrefix();
            chrome.storage.local.get(null, (result) => {
                const keys = Object.keys(result).filter(k => k.startsWith(prefix + 'color__'));
                if (keys.length > 0) {
                    chrome.storage.local.remove(keys, () => {
                        console.log(`🧹 已清理 ${keys.length} 个颜色图数据`);
                        sendResponse({ ok: true, cleared: keys.length });
                    });
                } else {
                    sendResponse({ ok: true, cleared: 0 });
                }
            });
            return true;
        }
        if (request.action === 'clearUploadedRows') {
            const key = uploadedKey();
            chrome.storage.local.remove(key, () => {
                console.log('🧹 已清理已上传状态');
                sendResponse({ ok: true });
            });
            return true;
        }
        if (request.action === 'clearAllOnNewFile') {
            const prefix = getFilePrefix();
            if (!prefix) {
                // H3 空前缀保护：无当前文件名时拒绝清理，避免 startsWith('') 命中全部键（含配置）
                console.warn('⛔ [clearAllOnNewFile] 未设置当前文件名，已跳过清理');
                sendResponse({ ok: false, error: '未设置当前文件名，已跳过清理' });
                return true;
            }
            chrome.storage.local.get(null, (result) => {
                const keys = Object.keys(result).filter(k =>
                    k.startsWith(prefix) ||
                    k === STORAGE_KEY
                    // 注意：color_images_row_* 是 legacy 迁移键（跨文件共享、迁移后即删），清理收益低，不再删除
                );
                chrome.storage.local.remove(keys, () => {
                    console.log(`🧹 新文件加载，清理当前文件数据: ${keys.length}项`);
                    sendResponse({ ok: true, cleared: keys.length });
                });
            });
            return true;
        }
        if (request.action === 'getConfig') {
            sendResponse({ ok: true, config: { imageDir: IMAGE_DIR, colorImgDir: COLOR_IMG_DIR } });
            return true;
        }
        if (request.action === 'updateConfig') {
            if (request.config) {
                // M3：目录值校验（外部消息通道同样校验）
                const invalid = [];
                if (request.config.imageDir !== undefined && !isValidDir(request.config.imageDir)) invalid.push('imageDir');
                if (request.config.colorImgDir !== undefined && !isValidDir(request.config.colorImgDir)) invalid.push('colorImgDir');
                if (invalid.length > 0) {
                    sendResponse({ ok: false, error: '非法目录: ' + invalid.join(', ') });
                    return true;
                }
                if (request.config.imageDir !== undefined) {
                    IMAGE_DIR = request.config.imageDir;
                    chrome.storage.local.set({ [IMAGE_DIR_KEY]: request.config.imageDir });
                    console.log('📂 图片目录已更新为:', IMAGE_DIR);
                }
                if (request.config.colorImgDir !== undefined) {
                    COLOR_IMG_DIR = request.config.colorImgDir;
                    chrome.storage.local.set({ [COLOR_IMG_DIR_KEY]: request.config.colorImgDir });
                    console.log('🖼️ 颜色图目录已更新为:', COLOR_IMG_DIR);
                }
                sendResponse({ ok: true, imageDir: IMAGE_DIR, colorImgDir: COLOR_IMG_DIR });
            } else {
                sendResponse({ ok: false, error: '缺少配置参数' });
            }
            return true;
        }
        // 扩展重载时间戳：页面据此自动刷新（SW 休眠不会改变它，故不会误刷）
        if (request.action === 'getExtBootInfo') {
            chrome.storage.local.get('polo_ext_reload_ts', (r) => {
                sendResponse({ ok: true, reloadTs: r['polo_ext_reload_ts'] || 0 });
            });
            return true;
        }
        // 兼容旧页面：不再保存或启用内存阈值。
        if (request.action === 'setMemPauseMB' || request.action === 'getSystemMemory') {
            sendResponse({ ok: true, disabled: true });
            return true;
        }
        handleSharedAction(request, sendResponse, sender).then(handled => {
            if (!handled) sendResponse({ ok: false, error: '未知消息动作：' + request.action });
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }).catch((err) => {
        console.warn('[onMessageExternal] 来源校验异常，拒绝:', err.message);
        sendResponse({ ok: false, error: '来源校验异常' });
    });
    return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
    // H1 第1层：长连接同样校验来源，不通过则断开
    isTrustedSender(port.sender).then((ok) => {
        if (!ok) {
            console.warn('⛔ [onConnectExternal] 拒绝未授权连接:', port.sender?.url || 'unknown');
            port.disconnect();
            return;
        }
        console.log('🔌 [onConnectExternal] 收到外部连接:', port.name, port.sender?.url || 'unknown');
        if (port.name === 'assistant-channel') {
            assistantPort = port;
            assistantTabId = port.sender?.tab?.id || null;
            console.log('✅ [onConnectExternal] 发品助手长连接已建立, tabId=', assistantTabId);
            // 连接建立后主动推一次任务状态：页面刷新/重连后能立刻恢复面板与暂停原因
            broadcastPublishState().catch(() => {});
            port.onDisconnect.addListener(() => {
                console.log('🔌 [onConnectExternal] 发品助手长连接已断开');
                assistantPort = null;
            });
            port.onMessage.addListener((msg) => {
                console.log('🔍 [onConnectExternal] 收到消息:', msg.action);
            });
        }
    }).catch((err) => {
        console.warn('[onConnectExternal] 来源校验异常，断开连接:', err.message);
        port.disconnect();
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log(`🔍 [onMessage] 收到消息: action=${request.action}, sender=${sender?.tab?.url ? 'tab' : 'unknown'}`);
    if (request.action === 'savePublishProduct' || request.action === 'recordPublishSaveClick') {
        savePublishProduct(request, sender, request.action === 'savePublishProduct').then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // ---------- 发品任务（内部通道：content script 发来，sender.tab 可信） ----------
    if (request.action === 'publishFilled') {
        const tabId = sender && sender.tab ? sender.tab.id : undefined;
        const frameId = sender ? sender.frameId : undefined;
        onPublishFilled(tabId, frameId, request).then(sendResponse).catch(e => sendResponse({ ok: false, message: e.message }));
        return true;
    }
    if (request.action === 'retryPublishRow') {
        retryPublishRow().then(sendResponse);
        return true;
    }
    if (request.action === 'skipPublishRow') {
        skipPublishRow().then(sendResponse);
        return true;
    }
    if (request.action === 'pausePublishQueue') {
        markPublishStop();   // 立即置闸门并递增停止代次（同上）
        loadPublishTask().then(t => {
            if (!t) { sendResponse({ ok: false, message: '没有发品任务' }); return; }
            pausePublishTask('manual', '用户手动停止').then(() => sendResponse({ ok: true }));
        });
        return true;
    }
    if (request.action === 'resumePublishQueue') {
        resumePublishTask().then(sendResponse).catch(e => sendResponse({ ok: false, message: e.message }));
        return true;
    }
    if (request.action === 'getPublishState') {
        buildPublishStatePayload().then(sendResponse);
        return true;
    }
    if (request.action === 'setPublishSettings') {
        setPublishSettings(request.patch || {}).then(s => sendResponse({ ok: true, settings: s }));
        return true;
    }
    if (request.action === 'getDiagLog') {
        chrome.storage.local.get(PUBLISH_LOG_KEY, r => sendResponse({ ok: true, log: r[PUBLISH_LOG_KEY] || [] }));
        return true;
    }
    if (request.action === 'clearDiagLog') {
        chrome.storage.local.remove(PUBLISH_LOG_KEY, () => sendResponse({ ok: true }));
        return true;
    }

    if (request.action === 'getProductData') {
        const key = productKey();
        chrome.storage.local.get(key, (result) => {
            sendResponse({ ok: true, data: result[key] || null });
        });
        return true;
    }

    if (request.action === 'updateConfig') {
        if (request.config) {
            // M3：目录值校验（onMessage 内部消息同样校验，防误配置）
            const invalid = [];
            if (request.config.imageDir !== undefined && !isValidDir(request.config.imageDir)) invalid.push('imageDir');
            if (request.config.colorImgDir !== undefined && !isValidDir(request.config.colorImgDir)) invalid.push('colorImgDir');
            if (invalid.length > 0) {
                sendResponse({ ok: false, error: '非法目录: ' + invalid.join(', ') });
                return true;
            }
            if (request.config.imageDir !== undefined) {
                IMAGE_DIR = request.config.imageDir;
                chrome.storage.local.set({ [IMAGE_DIR_KEY]: request.config.imageDir });
                console.log('📂 图片目录已更新为:', IMAGE_DIR);
            }
            if (request.config.colorImgDir !== undefined) {
                COLOR_IMG_DIR = request.config.colorImgDir;
                chrome.storage.local.set({ [COLOR_IMG_DIR_KEY]: request.config.colorImgDir });
                console.log('🖼️ 颜色图目录已更新为:', COLOR_IMG_DIR);
            }
            sendResponse({ ok: true, imageDir: IMAGE_DIR, colorImgDir: COLOR_IMG_DIR });
        } else {
            sendResponse({ ok: false, error: '缺少配置参数' });
        }
        return true;
    }

    if (request.action === 'getConfig') {
        sendResponse({ ok: true, config: { imageDir: IMAGE_DIR, colorImgDir: COLOR_IMG_DIR } });
        return true;
    }

    if (request.action === 'broadcastConfig') {
        sendResponse({ ok: true });
        return true;
    }

    if (request.action === 'heartbeat') {
        ensureConfigLoaded().then(() => {
            sendResponse({ ok: true, ts: Date.now() });
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (request.action === 'realMouseClick') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        const { x, y } = request;
        if (x === undefined || y === undefined) {
            sendResponse({ ok: false, error: '缺少坐标参数' });
            return false;
        }
        realClickCDP(tabId, x, y).then(result => {
            sendResponse(result);
        }).catch(err => {
            sendResponse({ ok: false, error: err.message });
        });
        return true;
    }

    if (request.action === 'runClickScript') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        const { selector } = request;
        // M1：不再拼接字符串 eval，selector 作为参数传入 executeScript，页面侧用 querySelector（防注入）
        chrome.scripting.executeScript({
            target: { tabId },
            func: (sel) => {
                const el = document.querySelector(sel);
                if (!el) return { ok: false, msg: '元素未找到' };
                const rect = el.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
                return { ok: true, msg: '点击完成', rect: { width: rect.width, height: rect.height } };
            },
            args: [selector]
        }).then(results => {
            if (results && results[0] && results[0].result) {
                sendResponse(results[0].result);
            } else {
                sendResponse({ ok: false, error: '脚本执行失败' });
            }
        }).catch(err => {
            sendResponse({ ok: false, error: err.message });
        });
        return true;
    }

    if (request.action === 'activateTab') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        chrome.tabs.update(tabId, { active: true }, () => {
            chrome.windows.update(sender.tab.windowId, { focused: true }, () => {
                sendResponse({ ok: true });
            });
        });
        return true;
    }

    if (request.action === 'startPsEdit') {
        startPsEdit(request.task).then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'psEditSave') {
        // L1：仅接受本次 startPsEdit 打开的 Photopea 标签页消息 + 数据大小上限（防伪造/超大占用）
        if (sender.tab?.id !== psEditState?.tabId) {
            console.warn('⛔ [PS编辑] 拒绝非 Photopea 来源的 psEditSave');
            sendResponse({ ok: false, error: '来源不符' });
            return true;
        }
        if ((request.data?.byteLength || 0) > 100 * 1024 * 1024) {
            console.warn('⛔ [PS编辑] psEditSave 数据过大拒绝:', request.data?.byteLength);
            sendResponse({ ok: false, error: '数据过大' });
            return true;
        }
        console.log('[PS编辑] background 收到 psEditSave 消息');
        handlePsEditSave(request.data);
        sendResponse({ ok: true });
        return true;
    }

    if (request.action === 'psEditSaveFsa') {
        // L1：来源与大小校验（同 psEditSave）
        if (sender.tab?.id !== psEditState?.tabId) {
            console.warn('⛔ [PS编辑] 拒绝非 Photopea 来源的 psEditSaveFsa');
            sendResponse({ ok: false, error: '来源不符' });
            return true;
        }
        if ((request.data?.byteLength || 0) > 100 * 1024 * 1024) {
            console.warn('⛔ [PS编辑] psEditSaveFsa 数据过大拒绝:', request.data?.byteLength);
            sendResponse({ ok: false, error: '数据过大' });
            return true;
        }
        console.log('[PS编辑] background 收到 psEditSaveFsa 消息，fileName:', request.fileName, 'data length:', request.data?.byteLength);
        handlePsEditSaveFsa(request.data, request.fileName);
        sendResponse({ ok: true });
        return true;
    }

    console.log(`🔍 [onMessage] 调用handleSharedAction: action=${request.action}`);
    const sharedActions = ['saveProductData', 'saveBatchProducts', 'getProductByRow', 'openPublishPage', 'openBatchPublish', 'publishCompleted', 'markUploaded', 'getUploadedRows', 'startColorChange', 'startAiEdit', 'startPsEdit', 'getColorImage', 'getColorImagesInfo', 'getColorImagePath', 'setCurrentFilename', 'getPsEditResult', 'clearPsEditResult', 'getConfig', 'colorTaskAccepted', 'getColorExecStatus', 'clearColorExec', 'getColorTaskEvents', 'pauseColorDispatch', 'getMemoryGate', 'pausePublishQueue', 'resumePublishQueue', 'getPublishState', 'setPublishSettings', 'getDiagLog', 'clearDiagLog', 'retryPublishRow', 'skipPublishRow', 'suiteCreate', 'suiteGetTask', 'suiteListTasks', 'suiteCancel', 'suiteProgress', 'suiteRecover', 'suiteRun'];
    if (sharedActions.includes(request.action)) {
        handleSharedAction(request, sendResponse, sender).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (request.action === 'uploadMainImage') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        const imagePath = request.imagePath;
        if (!imagePath) {
            sendResponse({ ok: false, error: '图片路径为空' });
            return false;
        }

        const pageType = request.pageType || 'page2';

        sendResponse({ ok: true, accepted: true });

        let uploadFn;
        if (pageType === 'page2') {
            uploadFn = uploadPage2ImageViaCDP;
        } else if (pageType === 'page3') {
            uploadFn = uploadPage3ImageViaCDP;
        } else {
            uploadFn = uploadPage2ImageViaCDP;
        }

        uploadFn(tabId, imagePath).then(result => {
            chrome.tabs.sendMessage(tabId, { action: 'uploadResult', result }).catch(() => {});
        }).catch(err => {
            chrome.tabs.sendMessage(tabId, { action: 'uploadResult', result: { ok: false, error: err.message } }).catch(() => {});
        });
        return true;
    }

    if (request.action === 'uploadAllImages') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        const imagePaths = request.imagePaths || [];
        if (imagePaths.length === 0) {
            sendResponse({ ok: false, error: '图片路径列表为空' });
            return false;
        }

        const pageType = request.pageType || 'page2';

        sendResponse({ ok: true, accepted: true });

        let uploadFn;
        if (pageType === 'page2') {
            uploadFn = uploadPage2ImageViaCDP;
        } else if (pageType === 'page3') {
            uploadFn = uploadPage3ImageViaCDP;
        } else {
            uploadFn = uploadPage2ImageViaCDP;
        }

        batchUploadImages(tabId, imagePaths, uploadFn).then(result => {
            chrome.tabs.sendMessage(tabId, { action: 'batchUploadResult', result }).catch(() => {});
        }).catch(err => {
            chrome.tabs.sendMessage(tabId, { action: 'batchUploadResult', result: { ok: false, error: err.message } }).catch(() => {});
        });
        return true;
    }

    if (request.action === 'uploadSkuColorImage') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        const { colorLabel, imagePath, iconX, iconY, itemIndex } = request;
        if (!colorLabel || !imagePath) {
            sendResponse({ ok: false, error: '缺少参数' });
            return false;
        }
        sendResponse({ ok: true, accepted: true });
        uploadColorImageViaCDP(tabId, colorLabel, imagePath, iconX, iconY, itemIndex).then(result => {
            chrome.tabs.sendMessage(tabId, { action: 'skuColorUploadResult', result }).catch(() => {});
        }).catch(err => {
            chrome.tabs.sendMessage(tabId, { action: 'skuColorUploadResult', result: { ok: false, error: err.message } }).catch(() => {});
        });
        return true;
    }

    if (request.action === 'startColorChange') {
        openDoubaoAndStartTask(request.task).then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'doubaoUploadImage') {
        const tabId = sender.tab?.id;
        uploadDoubaoImage(tabId, request.imagePath).then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'downloadDoubaoImage') {
        (async () => {
            const exec = await getActiveColorExec();
            if (!exec || exec.state !== 'accepted' || !sameColorExec(exec, request, sender) || !new RegExp('^row' + request.rowNum + '_(white|black|gray|navy)\\.(png|jpe?g)$', 'i').test(request.filename)) return { ok: false, error: '下载执行身份或图片行号不匹配' };
            return downloadDoubaoImage(request.url, request.filename, request.rowNum, Object.freeze({ ...exec }));
        })().then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'colorTaskComplete') {
        console.log('🎨 换色任务完成:', request.results);
        const rowNum = request.rowNum;
        if (rowNum) {
            const rawBatchId = request.batchId;
            const batchId = (typeof rawBatchId === 'string' && rawBatchId) ? rawBatchId : null;
            const eventKey = 'color_task_complete_event';
            // 身份校验基于【持久化执行身份】：冷启动后同样有效；不得被旧消息覆盖
            withColorCompletionLock(async () => {
                const exec = await getActiveColorExec();
                if (!exec) {
                    console.warn(`⛔ 无当前执行身份记录，拒绝换色完成消息: row${rowNum}（不静默当作单款任务）`);
                    sendResponse({ ok: false, error: '执行身份未知，已拒绝' });
                    return;
                }
                if (!sameColorExec(exec, request, sender) || exec.state === 'cancelled') {
                    console.warn(`⛔ 换色完成身份不匹配（收到 row${rowNum}/batch ${batchId || '(缺失)'}，当前 row${exec.rowNum}/batch ${exec.batchId || '(单款)'}），已拒绝且不覆盖已保存事件`);
                    sendResponse({ ok: false, error: '执行身份不匹配，已拒绝' });
                    return;
                }
                // 同一份不可变终态载荷：存储事件与所有通知通道共用，贯穿结果与执行/文件身份
                const payload = Object.freeze({
                    rowNum,
                    batchId,
                    fileKey: exec.fileKey || '',
                    fileFolder: exec.fileFolder || DEFAULT_FILE_FOLDER,
                    execStartedAt: exec.startedAt || 0,
                    executionId: exec.executionId || null,
                    results: request.results || null,
                    timestamp: Date.now()
                });
                if (exec.state === 'finished') { sendResponse({ ok: false, error: '重复完成消息' }); return; }
                await saveActiveColorExec({ ...exec, state: 'finished' });
                chrome.storage.local.set({ [eventKey]: payload }, () => {
                    console.log(`💾 换色完成事件已持久化: row${rowNum} (batch ${batchId || '-'})`);
                });
                notifyColorTaskComplete(rowNum, batchId, payload);
                // 注：执行结束状态已在上方写为 'finished'（重复完成守卫依赖它）。
                // 不要再用其它状态覆盖，否则重复完成消息会被再次接受（曾因此破坏守卫）。
                sendResponse({ ok: true });
            }).catch(() => sendResponse({ ok: false, error: '身份校验异常' }));
            return true;
        }
        sendResponse({ ok: true });
        return true;
    }

    if (request.action === 'getColorImage') {
        fetchColorImageAsBase64(request.rowNum, request.color, request.fileKey).then(result => {
            sendResponse(result);
        });
        return true;
    }

    if (request.action === 'getColorImagesInfo') {
        const storageKey = colorKey(request.rowNum);
        chrome.storage.local.get(storageKey, (result) => {
            let images = result[storageKey] || {};
            if (Object.keys(images).length === 0 && storageKey === 'color__' + request.rowNum) {
                const legacyKey = 'color_images_row_' + request.rowNum;
                chrome.storage.local.get(legacyKey, (legacyResult) => {
                    const legacyImages = legacyResult[legacyKey] || {};
                    if (Object.keys(legacyImages).length > 0) {
                        chrome.storage.local.set({ [storageKey]: legacyImages }, () => {
                            chrome.storage.local.remove(legacyKey);
                            console.log(`🔄 已迁移颜色图数据: ${legacyKey} → ${storageKey}`);
                        });
                        images = legacyImages;
                    }
                    sendResponse({ ok: true, images: Object.keys(images) });
                });
            } else {
                sendResponse({ ok: true, images: Object.keys(images) });
            }
        });
        return true;
    }

    if (request.action === 'getColorImagePath') {
        if (request.taskId) { handleSharedAction(request, sendResponse, sender).catch(e => sendResponse({ ok: false, error: e.message })); return true; }
        console.log(`🔍 [getColorImagePath] onMessage调用: rowNum=${request.rowNum}, color=${request.color}, COLOR_IMG_DIR=${COLOR_IMG_DIR}, CURRENT_FILENAME=${CURRENT_FILENAME}`);
        const responseFn = (data) => {
            console.log(`🔍 [getColorImagePath] onMessage收到回调，原始data: ${JSON.stringify(data)}`);
            data._debug = { colorImgDir: COLOR_IMG_DIR, currentFilename: CURRENT_FILENAME };
            console.log(`🔍 [getColorImagePath] onMessage返回数据: ${JSON.stringify(data)}`);
            try {
                sendResponse(data);
                console.log(`✅ [getColorImagePath] onMessage sendResponse成功`);
            } catch (e) {
                console.error(`❌ [getColorImagePath] onMessage sendResponse失败: ${e.message}`);
            }
        };
        getColorImagePathData(request.rowNum, request.color, responseFn);
        return true;
    }

    if (request.action === 'setCurrentFilename') {
        const nextName = request.filename || '';
        if (nextName === CURRENT_FILENAME) {
            sendResponse({ ok: true, filename: CURRENT_FILENAME, unchanged: true });
            return true;
        }
        colorDispatchStopped = true;
        colorDispatchEpoch++;
        markPublishStop();
        pausePublishTask('fileSwitch', '用户切换了当前 Excel 文件，任务已暂停').then(async () => {
            const prevName = CURRENT_FILENAME;
            await stopPendingColorDispatch();
            CURRENT_FILENAME = nextName;
            console.log(`📄 当前文件名切换为: ${CURRENT_FILENAME || '(默认)'}`);
            notifyAssistant('colorFileSwitched', { from: prevName, to: CURRENT_FILENAME });
            chrome.storage.local.set({ current_filename: CURRENT_FILENAME }, () => {
                sendResponse({ ok: true, filename: CURRENT_FILENAME });
            });
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (request.action === 'fillBoxRule') {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: '无法获取标签页ID' });
            return false;
        }
        sendResponse({ ok: true, accepted: true });

        // 由扩展 iframe 脚本完成操作，主页面另行核对关联结果。
        fillBoxRuleHybrid(tabId).then(result => {
            chrome.tabs.sendMessage(tabId, { action: 'fillBoxRuleResult', result }).catch(() => {});
        }).catch(err => {
            chrome.tabs.sendMessage(tabId, { action: 'fillBoxRuleResult', result: { ok: false, error: err.message } }).catch(() => {});
        });
        return true;
    }
    sendResponse({ ok: false, error: '未知消息动作：' + request.action });
    return false;
});

async function fillBoxRuleHybrid(tabId) {
    // 跨域弹窗由扩展的 iframe 脚本直接处理，避免从主页面访问 iframe.eval。
    return await fillBoxRuleViaIframeScript(tabId);
}

// 箱规填写方案2：向 scm.alibaba.com 的模板关联弹窗 iframe 注入 boxRuleIframe.js
// （webNavigation 事件定位 iframe 后 executeScript 注入）
async function fillBoxRuleViaIframeScript(tabId) {
    const sendLog = async (msg) => {
        try { await chrome.tabs.sendMessage(tabId, { action: 'log', msg }); } catch (_) {}
    };

    try {
        await sendLog('📦 查找箱规iframe...');
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        let targetFrameId = null;
        for (const frame of frames) {
            if (frame.url && frame.url.includes('scm.alibaba.com') && frame.url.includes('template_relate_package')) {
                targetFrameId = frame.frameId;
                await sendLog(`📦 找到iframe: frameId=${frame.frameId}, url=${frame.url}`);
                break;
            }
        }

        if (!targetFrameId) {
            await sendLog('❌ 未找到箱规iframe');
            return { ok: false, error: '未找到箱规iframe' };
        }

        // ping检测iframe content script是否已加载
        await sendLog('📦 Ping检测iframe content script...');
        const pingResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { action: 'pingBoxRuleIframe' }, { frameId: targetFrameId }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                } else {
                    resolve(response || { ok: false });
                }
            });
        });

        if (!pingResult.ok) {
            await sendLog('⚠️ iframe content script未响应，尝试动态注入...');
            try {
                await chrome.scripting.executeScript({
                    target: { tabId, frameIds: [targetFrameId] },
                    files: ['content/boxRuleIframe.js']
                });
                await sendLog('✅ 动态注入成功，等待加载...');
                await new Promise(r => setTimeout(r, 1500));
            } catch (injectErr) {
                await sendLog('❌ 动态注入失败: ' + injectErr.message);
                return { ok: false, error: '注入失败: ' + injectErr.message };
            }
        } else {
            await sendLog('✅ iframe content script已就绪');
        }

        await sendLog('📦 发送fillBoxRuleIframe消息...');
        const result = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { action: 'fillBoxRuleIframe' }, { frameId: targetFrameId }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                } else {
                    resolve(response || { ok: false, error: '无响应' });
                }
            });
        });

        await sendLog(`📊 iframe执行结果: ${JSON.stringify(result)}`);
        return result;
    } catch (e) {
        await sendLog('❌ iframe脚本方式失败: ' + e.message);
        return { ok: false, error: e.message };
    }
}

async function batchUploadImages(tabId, imagePaths, uploadFn) {
    const sendLog = async (msg) => {
        try { await chrome.tabs.sendMessage(tabId, { action: 'log', msg }); } catch (_) {}
    };
    let success = 0;
    for (let i = 0; i < imagePaths.length; i++) {
        await sendLog(`📤 上传第 ${i + 1}/${imagePaths.length} 张图...`);
        const r = await uploadFn(tabId, imagePaths[i]);
        if (r.ok) success++;
        await new Promise(r => setTimeout(r, 1000));
    }
    await sendLog(`✅ 批量上传完成: ${success}/${imagePaths.length} 张成功`);
    return { ok: success > 0, success, total: imagePaths.length };
}

async function findDoubaoTab() {
    const tabs = await chrome.tabs.query({ url: ['*://www.doubao.com/*', '*://doubao.com/*'] });
    if (tabs.length > 0) return tabs[0];
    return null;
}

let colorStartLock = Promise.resolve();
function openDoubaoAndStartTask(task) {
    const epochAtRequest = colorDispatchEpoch;
    const next = colorStartLock.then(() => openDoubaoAndStartTaskLocked(task, epochAtRequest));
    colorStartLock = next.catch(() => {});
    return next;
}
async function openDoubaoAndStartTaskLocked(task, epochAtRequest) {
    if (epochAtRequest !== colorDispatchEpoch) return { ok: false, error: '等待派发期间收到停止请求' };
    console.log('🎨 启动豆包AI换色任务:', task);
    // 保留上一份"已接收"身份：豆包繁忙被拒时不得覆盖原活动执行身份
    const prevExec = await getActiveColorExec();
    if (prevExec && (prevExec.state === 'accepted' || prevExec.state === 'pending')) {
        return { ok: false, busy: true, error: '已有执行或待接收任务，未覆盖原执行身份' };
    }
    if (task.fileKey !== undefined && task.fileKey !== getFilePrefix()) return { ok: false, error: '换色任务所属 Excel 已切换' };
    if (epochAtRequest !== colorDispatchEpoch) return { ok: false, error: '启动期间收到停止请求' };
    colorDispatchStopped = false;
    task = { ...task, executionId: task.executionId || ('ce_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
        fileKey: task.fileKey === undefined ? getFilePrefix() : task.fileKey,
        fileFolder: task.fileFolder || CURRENT_FILENAME || DEFAULT_FILE_FOLDER };
    const nextExec = {
        batchId: (task && typeof task.batchId === 'string' && task.batchId) ? task.batchId : null,
        rowNum: task && task.rowNum,
        source: (task && task.batchId) ? 'batch' : 'single',
        // 文件绑定：执行期内固定，贯穿下载/缓存/通知；异步回调不再读可变的 CURRENT_FILENAME
        fileKey: (task && typeof task.fileKey === 'string') ? task.fileKey : getFilePrefix(),
        fileFolder: (task && typeof task.fileFolder === 'string' && task.fileFolder) ? task.fileFolder : (CURRENT_FILENAME || DEFAULT_FILE_FOLDER),
        executionId: task.executionId,
        dispatchAllowed: true,
        state: 'pending',   // pending=待派发 / accepted=豆包已确认接收
        tabId: null,        // 接收后写入实际执行页，供状态查询绑定
        startedAt: Date.now()
    };
    await saveActiveColorExec(nextExec);
    await savePendingColorTask(task);
    if (epochAtRequest !== colorDispatchEpoch) { await stopPendingColorDispatch(); return { ok: false, error: '启动期间收到停止请求' }; }

    let tab = await findDoubaoTab();
    if (tab) {
        doubaoTabId = tab.id;
        await saveDoubaoTabId(tab.id);
        if (!await bindPendingColorTab(task, tab.id)) return { ok: false, error: '派发已停止或文件已切换' };
        await chrome.tabs.update(tab.id, { active: true });
        console.log('📌 找到已有豆包标签页:', tab.id);
        await new Promise(r => setTimeout(r, 1000));
        // 必须等待接收结果：busy / 拒绝要传回页面，不能无条件返回 ok:true
        if (!await colorDispatchAllowed(task, tab.id)) return { ok: false, error: '派发已停止或文件已切换' };
        const resp = await sendStartColorTask(tab.id, task);
        if (!resp || !resp.ok) {
            if (resp && resp.busy) {
                console.warn('⛔ 豆包仍在执行上一个任务，未接收新任务；撤销本次待派发记录并恢复原执行身份');
                await savePendingColorTask(null);            // 撤销本次待派发
                await saveActiveColorExec(prevExec || null); // 恢复原活动执行身份
                return { ok: false, busy: true, error: resp.error || '豆包仍在执行上一个任务', tabId: doubaoTabId };
            }
            // 通信失败（页面可能尚未就绪）：保留 pending 身份，等页面自行拉取
            console.warn('⚠️ 派发通信失败，保留待派发状态:', (resp && resp.error) || '无响应');
            return { ok: false, pending: true, error: (resp && resp.error) || '通信失败', tabId: doubaoTabId };
        }
        const confirmed = await withColorCompletionLock(async () => {
            const currentExec = await getActiveColorExec();
            if (!sameColorExec(currentExec, task) || currentExec.state === 'cancelled'
                || (currentExec.state === 'pending' && colorDispatchStopped)) return false;
            if (currentExec.state !== 'finished') await saveActiveColorExec({ ...currentExec, state: 'accepted', acceptedAt: Date.now(), tabId: tab.id });
            await savePendingColorTask(null);
            return true;
        });
        if (!confirmed) return { ok: false, error: '派发已停止' };
        return { ok: true, tabId: doubaoTabId, accepted: true };
    }

    console.log('🌐 打开新的豆包标签页...');
    if (!await colorDispatchAllowed(task)) return { ok: false, error: '派发已停止或文件已切换' };
    const newTab = await chrome.tabs.create({ url: DOUBAO_URL, active: true });
    doubaoTabId = newTab.id;
    await saveDoubaoTabId(newTab.id);
    if (!await bindPendingColorTab(task, newTab.id)) return { ok: false, error: '开页期间已停止，保留页面但不派发任务' };
    // 新页加载后再派发：身份先记为 pending，doubao 真正启动后回传 accepted
    return { ok: true, tabId: doubaoTabId, pending: true };
}

async function openDoubaoForAiEdit(task) {
    console.log('🤖 启动豆包AI改图任务:', task);
    const exec = await getActiveColorExec();
    if (exec && ['pending', 'accepted'].includes(exec.state)) return { ok: false, busy: true, error: '换色任务尚未结束，请等它完成后再改图' };
    task = { ...task, fileKey: getFilePrefix(), executionId: 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2) };

    let tab = await findDoubaoTab();
    if (tab) {
        doubaoTabId = tab.id;
        await chrome.tabs.update(tab.id, { active: true });
        console.log('📌 找到已有豆包标签页:', tab.id);
        await new Promise(r => setTimeout(r, 1000));
        return { ...await sendStartAiEditTask(tab.id, task), tabId: tab.id };
    } else {
        console.log('🌐 打开新的豆包标签页...');
        const newTab = await chrome.tabs.create({ url: DOUBAO_URL, active: true });
        doubaoTabId = newTab.id;
        task.tabId = newTab.id;
        await new Promise(resolve => chrome.storage.local.set({ [PENDING_AI_EDIT_KEY]: task }, resolve));
        return { ok: true, pending: true, tabId: newTab.id };
    }
    return { ok: true, tabId: doubaoTabId };
}

async function sendStartAiEditTask(tabId, task) {
    if (task.fileKey !== undefined && task.fileKey !== getFilePrefix()) return { ok: false, error: '改图任务所属文件已切换' };
    try { return await chrome.tabs.sendMessage(tabId, { action: 'startAiEditTask', task }) || { ok: false, error: '豆包页面无响应' }; }
    catch (err) { return { ok: false, error: err.message }; }
}

async function sendStartColorTask(tabId, task) {
    try {
        const resp = await chrome.tabs.sendMessage(tabId, { action: 'startColorTask', task });
        return resp || { ok: false, error: '豆包页面无响应' };
    } catch (e) {
        console.log('⚠️ 发送任务失败，等待页面加载:', e.message);
        return { ok: false, error: e.message };
    }
}

async function uploadDoubaoImage(tabId, imagePath) {
    console.log('🖼️ 豆包页面上传图片:', imagePath);
    let attached = false;
    let targetId;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: false });
        targetId = tabId || tab?.id;
        if (!targetId) throw new Error('无法获取标签页ID');

        try {
            await chrome.debugger.attach({ tabId: targetId }, '1.3');
            attached = true;
        } catch (e) {
            console.log('Debugger 已连接或连接失败:', e.message);
        }

        const doc = await chrome.debugger.sendCommand({ tabId: targetId }, 'DOM.getDocument');
        const rootNodeId = doc.root.nodeId;

        const { nodeIds } = await chrome.debugger.sendCommand({ tabId: targetId }, 'DOM.querySelectorAll', {
            nodeId: rootNodeId,
            selector: 'input[type="file"]'
        });

        let targetNodeId = null;
        if (nodeIds && nodeIds.length > 0) {
            for (const nid of nodeIds) {
                try {
                    const result = await chrome.debugger.sendCommand({ tabId: targetId }, 'DOM.describeNode', { nodeId: nid });
                    if (result?.node) {
                        targetNodeId = nid;
                        break;
                    }
                } catch (_) {}
            }
        }

        if (!targetNodeId) {
            throw new Error('未找到文件输入框');
        }

        await chrome.debugger.sendCommand({ tabId: targetId }, 'DOM.setFileInputFiles', {
            nodeId: targetNodeId,
            files: [imagePath]
        });

        console.log('✅ 豆包图片上传成功');
        return { ok: true };
    } catch (e) {
        console.error('❌ 豆包图片上传失败:', e.message);
        return { ok: false, error: e.message };
    } finally {
        if (attached) {
            try { await chrome.debugger.detach({ tabId: targetId }); } catch (_) {}
        }
    }
}

// AI 换色图片下载：优先预取 blob 转 data URL（MV3 SW 无 URL.createObjectURL）并存 IDB，
// 再走 chrome.downloads 落盘到 Polo发品_颜色图/{文件名}/rowN/；
// 强制文件名经 downloadFilenameMap（id/url 匹配）由 onDeterminingFilename 生效；
// 失败降级 downloadViaFetch（fetch 拉取后 downloads 下载）
async function downloadDoubaoImage(url, filename, rowNum, execution) {
    return new Promise(async (resolve) => {
        try {
            // M2-①：filename 白名单校验，拒绝路径分隔符/绝对路径/..（防覆盖下载目录外文件）
            // 注意：RegExp.test(null) 会把 null 转 "null"（全在白名单内返回 true），必须先 typeof 检查
            // L3：额外拒绝 Windows 保留设备名（CON/NUL/COM1 等）
            if (typeof filename !== 'string' || !SAFE_FILENAME_RE.test(filename) || filename.includes('..') || isReservedWindowsName(filename)) {
                console.warn('⛔ 非法下载文件名:', filename);
                return resolve({ ok: false, error: '非法文件名' });
            }
            // 文件绑定：一律使用执行创建时绑定的文件，异步下载/回调期间切文件也不串目录
            const bound = boundColorFileInfo(execution);
            const fileFolder = bound.fileFolder || DEFAULT_FILE_FOLDER; // 与 buildColorImagePath 读盘侧保持一致
            const relativePath = 'Polo发品_颜色图/' + fileFolder + '/row' + rowNum + '/' + filename;

            const colorMatch = filename.match(/_(white|black|gray|navy)\./);
            let dataUrl = null;
            if (colorMatch) {
                try {
                    const resp = await fetch(url, { headers: { 'Referer': 'https://www.doubao.com/' } });
                    if (resp.ok) {
                        const blob = await resp.blob();
                        // M2-②/M4：非 raster 图片响应（登录墙/劫持的 HTML、SVG 脚本等）不生成 data URL，
                        // 回退原始 URL 下载以保留 Chrome 对危险类型的防护
                        if (isRasterImageType(blob.type)) {
                            // MV3 Service Worker 没有 URL.createObjectURL，用 data URL 替代
                            dataUrl = await new Promise((r) => {
                                const reader = new FileReader();
                                reader.onloadend = () => r(reader.result);
                                reader.onerror = () => r(null);
                                reader.readAsDataURL(blob);
                            });
                            console.log(`[download] dataUrl created: ${dataUrl ? dataUrl.slice(0, 60) + '...' : 'null'}`);
                            // 同时存 IndexedDB
                            if (dataUrl) {
                                const color = colorMatch[1];
                                const idbKey = colorImageIDBKey(bound.fileFolder === DEFAULT_FILE_FOLDER ? '' : bound.fileFolder, rowNum, color);
                                saveColorImageToIDB(idbKey, dataUrl).then(() => {
                                    console.log(`💾 颜色图已存 IndexedDB(预取): ${idbKey}`);
                                });
                            }
                        } else {
                            console.warn(`[download] 响应非图片类型（${blob.type || 'unknown'}），跳过 data URL，回退原始 URL 下载`);
                        }
                    }
                } catch (e) {
                    console.warn('预取图片存 IndexedDB 失败:', e.message);
                }
            }

            const downloadUrl = dataUrl && dataUrl.length <= 5 * 1024 * 1024 ? dataUrl : url;
            console.log(`[download] using url type: ${downloadUrl === dataUrl ? 'data' : 'original'}, filename: ${relativePath}`);

            // 关键：download() 之前按 URL 预登记。onDeterminingFilename 可能先于回调触发
            // （data: URL 无需联网即可定 MIME），只在回调里登记会漏匹配 → suggest() 不调 → 丢文件名
            const preKey = 'pre:' + downloadUrl;
            downloadFilenameMap.set(preKey, { filename, relativePath, url: downloadUrl });
            
            chrome.downloads.download({
                url: downloadUrl,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false
            }, (downloadId) => {
                // 回调里把预登记条目迁移到真实 downloadId（命中后 url 键可能已被监听器消费）
                downloadFilenameMap.delete(preKey);
                if (downloadId !== undefined) {
                    downloadFilenameMap.set(downloadId, { filename, relativePath, url: downloadUrl });
                }
                
                if (chrome.runtime.lastError) {
                    console.warn(`⚠️ chrome.downloads 失败，改用 fetch 方式: ${chrome.runtime.lastError.message}`);
                    downloadViaFetch(url, filename, rowNum, relativePath, bound).then(resolve);
                    return;
                }
                console.log(`📥 开始下载: ${filename} (id: ${downloadId})`);

                const onChanged = (delta) => {
                    if (delta.id !== downloadId) return;
                    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
                        // 下载结束/中断时清理文件名映射，避免泄漏（命中后 onDeterminingFilename 也会删除）
                        downloadFilenameMap.delete(downloadId);
                    }
                    if (delta.state && delta.state.current === 'complete') {
                        chrome.downloads.search({ id: downloadId }, (items) => {
                            if (items && items[0]) {
                                const fullPath = items[0].filename;
                                const storageKey = bound.fileKey + 'color__' + rowNum;
                                const colorMatch = filename.match(/_(white|black|gray|navy)\./);
                                console.log(`💾 下载完成: ${filename} → ${fullPath}, storageKey=${storageKey}, colorMatch=`, colorMatch);
                                chrome.downloads.onChanged.removeListener(onChanged);
                                
                                if (colorMatch) {
                                    const color = colorMatch[1];
                                    chrome.storage.local.get(storageKey, (result) => {
                                        const images = result[storageKey] || {};
                                        images[color] = { url, path: fullPath };
                                        chrome.storage.local.set({ [storageKey]: images }, () => {
                                            console.log(`💾 已保存颜色图: row${rowNum}/${color} → ${fullPath}`);
                                            resolve({ ok: true, filename, path: fullPath });
                                        });
                                    });
                                } else {
                                    console.warn(`⚠️ 颜色匹配失败: ${filename}`);
                                    resolve({ ok: true, filename, path: fullPath });
                                }
                            }
                        });
                    }
                    if (delta.error) {
                        chrome.downloads.onChanged.removeListener(onChanged);
                        console.warn(`⚠️ 下载出错，改用 fetch 方式: ${delta.error.current}`);
                        downloadViaFetch(url, filename, rowNum, relativePath, bound).then(resolve);
                    }
                };
                chrome.downloads.onChanged.addListener(onChanged);

                setTimeout(() => {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    resolve({ ok: false, error: '下载超时' });
                }, 60000);
            });
        } catch (e) {
            console.error('❌ 下载失败:', e.message);
            resolve({ ok: false, error: e.message });
        }
    });
}

const COLOR_NAMES = ['white', 'black', 'gray', 'navy'];

async function notifyColorTaskComplete(rowNum, batchId, payload) {
    // 终态载荷必须与存储事件同源：结果/执行身份/文件身份一并送达，页面才能正确判定成败
    const extra = payload ? {
        results: payload.results || null,
        fileKey: payload.fileKey || '',
        fileFolder: payload.fileFolder || '',
        execStartedAt: payload.execStartedAt || 0,
        executionId: payload.executionId || null,
        timestamp: payload.timestamp
    } : {};
    if (assistantPort) {
        try {
            assistantPort.postMessage(Object.assign({ action: 'colorTaskComplete', rowNum, batchId }, extra));
            console.log('✅ 已通过长连接通知发品助手换色完成');
            return;
        } catch (e) {
            console.log('⚠️ 长连接发送失败:', e.message);
            assistantPort = null;
        }
    }

    if (assistantTabId) {
        try {
            await chrome.tabs.sendMessage(assistantTabId, Object.assign({ action: 'colorTaskComplete', rowNum, batchId }, extra));
            console.log('✅ 已通过 tabs.sendMessage 通知发品助手换色完成');
            return;
        } catch (e) {
            console.log('⚠️ tabs.sendMessage 失败:', e.message);
        }
    }

    try {
        const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage(EXTENSION_ID, Object.assign({ action: 'colorTaskComplete', rowNum, batchId }, extra), (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                } else {
                    resolve(response || { ok: false });
                }
            });
        });
        if (result.ok) {
            console.log('✅ 已通过 chrome.runtime.sendMessage 通知发品助手换色完成');
            return;
        }
    } catch (e) {
        console.log('⚠️ chrome.runtime.sendMessage 失败:', e.message);
    }

    console.log('⚠️ 所有通知方式均失败，尝试查找发品助手标签页...');
    try {
        const tabs = await chrome.tabs.query({ url: '*://*/发品助手.html', currentWindow: true });
        if (tabs.length > 0) {
            assistantTabId = tabs[0].id;
            await chrome.tabs.sendMessage(assistantTabId, Object.assign({ action: 'colorTaskComplete', rowNum, batchId }, extra));
            console.log('✅ 通过查找标签页成功通知发品助手');
            return;
        }
    } catch (e) {
        console.log('⚠️ 查找标签页并通知失败:', e.message);
    }

    try {
        const tabs = await chrome.tabs.query({ url: 'file://*/*发品助手.html', currentWindow: true });
        if (tabs.length > 0) {
            assistantTabId = tabs[0].id;
            console.log('📌 找到发品助手标签页:', assistantTabId);
            try {
                await chrome.tabs.sendMessage(assistantTabId, Object.assign({ action: 'colorTaskComplete', rowNum, batchId }, extra));
                console.log('✅ 通过 tabs.sendMessage 成功通知发品助手');
                return;
            } catch (e) {
                console.log('⚠️ tabs.sendMessage 仍失败，尝试重新建立连接...');
            }
        }
    } catch (e) {
        console.log('⚠️ 查找 file:// 标签页失败:', e.message);
    }

    console.log('❌ 无法通知发品助手，换色任务完成消息丢失');
}

async function downloadViaFetch(url, filename, rowNum, relativePath, bound) {
    try {
        if (!bound) throw new Error('缺少下载文件身份');
        console.log(`🔄 使用 fetch 方式下载: ${filename}`);
        const response = await fetch(url, {
            headers: { 'Referer': 'https://www.doubao.com/' }
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);

        const blob = await response.blob();
        // L4：MV3 Service Worker 无 URL.createObjectURL，改用 data URL（与 downloadDoubaoImage 主路径一致）
        // 安全：非 raster 图片响应不生成 data URL（保持 Chrome 对危险 MIME/SVG 的防护），回退原始 URL 直下
        let dataUrl = null;
        if (isRasterImageType(blob.type)) {
            dataUrl = await new Promise((resolveData, rejectData) => {
                const reader = new FileReader();
                reader.onloadend = () => resolveData(reader.result);
                reader.onerror = () => rejectData(new Error('读取 blob 失败'));
                reader.readAsDataURL(blob);
            });
        } else {
            console.warn('[download] fetch 响应非图片类型，回退原始 URL 下载:', blob.type || 'unknown');
        }

        const colorMatch = filename.match(/_(white|black|gray|navy)\./);
        if (colorMatch && dataUrl) {
            const color = colorMatch[1];
            const idbKey = colorImageIDBKey(bound.fileKey.endsWith('__') ? bound.fileKey.slice(0, -2) : bound.fileKey, rowNum, color);
            saveColorImageToIDB(idbKey, dataUrl).then(() => {
                console.log(`💾 颜色图已存 IndexedDB: ${idbKey}`);
            });
        }

        // L4：超大 data URL 超出 downloads.download 限制（>5MB 回退原始 URL 直下）
        const downloadUrl = dataUrl && dataUrl.length <= 5 * 1024 * 1024 ? dataUrl : url;

        // 关键：兜底路径同样要按 URL 预登记映射，否则走这里必然丢文件名
        // （只要有扩展注册 onDeterminingFilename，Chrome 就会忽略 DownloadOptions.filename）
        const preKey = 'pre:' + downloadUrl;
        downloadFilenameMap.set(preKey, { filename, relativePath, url: downloadUrl });

        return new Promise((resolve) => {
            chrome.downloads.download({
                url: downloadUrl,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false
            }, (downloadId) => {
                downloadFilenameMap.delete(preKey);
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }

                const onChanged = (delta) => {
                    if (delta.id !== downloadId) return;
                    if (delta.state && delta.state.current === 'complete') {
                        chrome.downloads.search({ id: downloadId }, (items) => {
                            if (items && items[0]) {
                                const fullPath = items[0].filename;
                                const storageKey = bound.fileKey + 'color__' + rowNum;
                                const colorMatch = filename.match(/_(white|black|gray|navy)\./);
                                console.log(`💾 下载完成(fetch): ${filename} → ${fullPath}, storageKey=${storageKey}, colorMatch=`, colorMatch);
                                chrome.downloads.onChanged.removeListener(onChanged);
                                
                                if (colorMatch) {
                                    const color = colorMatch[1];
                                    chrome.storage.local.get(storageKey, (result) => {
                                        const images = result[storageKey] || {};
                                        images[color] = { url, path: fullPath };
                                        chrome.storage.local.set({ [storageKey]: images }, () => {
                                            console.log(`💾 已保存颜色图(fetch): row${rowNum}/${color} → ${fullPath}`);
                                            resolve({ ok: true, filename, path: fullPath });
                                        });
                                    });
                                } else {
                                    console.warn(`⚠️ 颜色匹配失败(fetch): ${filename}`);
                                    resolve({ ok: true, filename, path: fullPath });
                                }
                            }
                        });
                    }
                    if (delta.error) {
                        chrome.downloads.onChanged.removeListener(onChanged);
                        resolve({ ok: false, error: delta.error.current });
                    }
                };
                chrome.downloads.onChanged.addListener(onChanged);

                setTimeout(() => {
                    // data URL 无需 revoke（L4 已移除 blobUrl）；超时清理监听并返回
                    chrome.downloads.onChanged.removeListener(onChanged);
                    resolve({ ok: false, error: '下载超时' });
                }, 60000);
            });
        });
    } catch (e) {
        console.error('❌ fetch 下载失败:', e.message);
        return { ok: false, error: e.message };
    }
}

async function fetchColorImageAsBase64(rowNum, color, expectedFileKey) {
    const fileKey = getFilePrefix(), fileName = CURRENT_FILENAME;
    if (expectedFileKey !== undefined && expectedFileKey !== fileKey) return { ok: false, error: '颜色图所属文件已切换' };
    try {
        const idbKey = colorImageIDBKey(fileName, rowNum, color);
        const cached = await getColorImageFromIDB(idbKey);
        if (cached) {
            console.log(`✅ 颜色图从 IndexedDB 命中: ${idbKey}`);
            return { ok: true, dataUrl: cached };
        }

        const storageKey = fileKey + 'color__' + rowNum;
        let result = await new Promise((resolve) => {
            chrome.storage.local.get(storageKey, (r) => resolve(r));
        });
        let images = result[storageKey] || {};
        if (Object.keys(images).length === 0 && !fileKey) {
            const legacyKey = 'color_images_row_' + rowNum;
            const legacyResult = await new Promise((resolve) => {
                chrome.storage.local.get(legacyKey, (r) => resolve(r));
            });
            const legacyImages = legacyResult[legacyKey] || {};
            if (Object.keys(legacyImages).length > 0) {
                await new Promise((resolve) => {
                    chrome.storage.local.set({ [storageKey]: legacyImages }, () => resolve());
                });
                chrome.storage.local.remove(legacyKey);
                console.log(`🔄 已迁移颜色图数据: ${legacyKey} → ${storageKey}`);
                images = legacyImages;
            }
        }
        const imgData = images[color];
        const url = typeof imgData === 'string' ? imgData : imgData?.url;
        if (!url) return { ok: false, error: '图片URL不存在' };

        const response = await fetch(url, {
            headers: {
                'Referer': 'https://www.doubao.com/'
            }
        });
        if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };

        const blob = await response.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result;
                saveColorImageToIDB(idbKey, dataUrl).then(() => {
                    console.log(`💾 颜色图缓存到 IndexedDB: ${idbKey}`);
                });
                resolve({ ok: true, dataUrl });
            };
            reader.onerror = () => {
                resolve({ ok: false, error: '读取失败' });
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

const PS_SAVE_MARKER = 'http://ps-edit-save.local/save';
let psEditState = null;

// Photopea 在线 PS 编辑：打开 photopea.com（hash 携带图片 dataURL 与保存标记），
// 注入 MAIN world fetch 拦截器捕获保存请求 + ISOLATED world 消息桥转发到扩展；
// 保存结果经 psEditComplete 回写发品助手
async function startPsEdit(task) {
    const { imageDataUrl, fileName, rowNum, imageDir } = task;
    const baseFileName = fileName
        .replace(/\.(jpg|jpeg|png|gif|webp)$/i, '')
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_'); // H2 白名单清洗：字母/数字/中文/._-，防注入 Photopea 脚本
    console.log('🖌️ 启动PS编辑:', { fileName, baseFileName, rowNum });

    const config = {
        files: [imageDataUrl],
        server: {
            version: 1,
            url: PS_SAVE_MARKER,
            formats: ['png']
        },
        script: `app.activeDocument.name = ${JSON.stringify(baseFileName)};` // H2：JSON 转义防引号注入
    };
    const hash = encodeURIComponent(JSON.stringify(config));
    const url = `https://www.photopea.com#${hash}`;

    const tab = await chrome.tabs.create({ url, active: true });
    const tabId = tab.id;

    psEditState = {
        tabId,
        fileName,
        rowNum,
        imageDir: imageDir || IMAGE_DIR,
        saved: false
    };

    await new Promise(r => setTimeout(r, 3000));

    try {
        console.log('[PS编辑] 开始注入拦截脚本到 MAIN world...');
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: injectFetchInterceptor,
            args: [PS_SAVE_MARKER, fileName]
        });
        console.log('[PS编辑] MAIN world 脚本注入成功');

        console.log('[PS编辑] 开始注入消息桥到 ISOLATED world...');
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: injectMessageBridge
        });
        console.log('[PS编辑] ISOLATED world 消息桥注入成功');

        console.log('✅ PS编辑页面已打开，拦截脚本已注入');
        return { ok: true, tabId };
    } catch (e) {
        console.error('❌ 注入脚本失败:', e.message);
        return { ok: false, error: e.message };
    }
}

function injectFetchInterceptor(markerUrl, fileName) {
    window.__psEditFileName = fileName;
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = args[0];
        if (typeof url === 'string' && url === markerUrl) {
            const request = args[1] || {};
            const body = request.body;
            if (body) {
                const reader = new FileReader();
                reader.onload = () => {
                    window.postMessage({
                        type: 'PS_EDIT_SAVE',
                        data: reader.result
                    }, '*');
                };
                reader.readAsArrayBuffer(body);
            }
            return new Response(JSON.stringify({ message: 'ok' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch.apply(this, args);
    };

    const originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        if (this._url === markerUrl || this.responseURL === markerUrl) {
            if (body) {
                const reader = new FileReader();
                reader.onload = () => {
                    window.postMessage({
                        type: 'PS_EDIT_SAVE',
                        data: reader.result
                    }, '*');
                };
                reader.readAsArrayBuffer(body);
            }
            Object.defineProperty(this, 'status', { value: 200 });
            Object.defineProperty(this, 'responseText', { value: JSON.stringify({ message: 'ok' }) });
            Object.defineProperty(this, 'readyState', { value: 4 });
            if (this.onreadystatechange) this.onreadystatechange();
            if (this.onload) this.onload();
            return;
        }
        return originalXHRSend.apply(this, arguments);
    };

    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalXHROpen.apply(this, arguments);
    };



    if ('showOpenFilePicker' in window) {
        const originalShowOpenFilePicker = window.showOpenFilePicker;
        window.showOpenFilePicker = function() {
            return originalShowOpenFilePicker.apply(this, arguments);
        };
    }

    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
        const url = originalCreateObjectURL.call(this, blob);
        console.log('[PS拦截] URL.createObjectURL 被调用', blob.type, blob.size);
        return url;
    };

    document.addEventListener('click', function(e) {
        const target = e.target.closest('a[download]');
        if (target && target.href && target.href.startsWith('blob:')) {
            console.log('[PS拦截] 拦截到 download 链接点击，href:', target.href);
            e.preventDefault();
            e.stopPropagation();
            fetch(target.href)
                .then(res => res.blob())
                .then(blob => {
                    console.log('[PS拦截] fetch blob 成功，type:', blob.type, 'size:', blob.size);
                    const reader = new FileReader();
                    reader.onload = function() {
                        const arrayBuffer = reader.result;
                        const uint8 = new Uint8Array(arrayBuffer);
                        let format = 'png';
                        if (uint8.length > 2 && uint8[0] === 0xFF && uint8[1] === 0xD8) {
                            format = 'jpg';
                        } else if (uint8.length > 8 && uint8[0] === 0x89 && uint8[1] === 0x50) {
                            format = 'png';
                        } else if (uint8.length > 12 && uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50) {
                            format = 'webp';
                        }
                        console.log('[PS拦截] 图片数据读取完成，格式:', format);
                        const targetFileName = window.__psEditFileName || 'image.' + format;
                        console.log('[PS拦截] 准备保存文件:', targetFileName);
                        const blob = new Blob([uint8], { type: format === 'png' ? 'image/png' : format === 'jpg' ? 'image/jpeg' : 'image/webp' });
                        
                        async function saveFile(dirHandle, fileName, blobData) {
                            try {
                                const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
                                const writable = await fileHandle.createWritable();
                                await writable.write(blobData);
                                await writable.close();
                                console.log('[PS拦截] ✅ 文件保存成功:', fileName);
                                alert('✅ PS编辑图片已保存: ' + fileName);
                            } catch (e) {
                                console.error('[PS拦截] ❌ 文件保存失败:', e);
                                alert('❌ 保存失败: ' + e.message);
                            }
                        }
                        
                        async function getDirHandle() {
                            if (window.__psEditDirHandle) {
                                const perm = await window.__psEditDirHandle.queryPermission({ mode: 'readwrite' });
                                if (perm === 'granted') return window.__psEditDirHandle;
                                const requested = await window.__psEditDirHandle.requestPermission({ mode: 'readwrite' });
                                if (requested === 'granted') return window.__psEditDirHandle;
                            }
                            
                            // 尝试从 IndexedDB 恢复句柄
                            try {
                                const db = await new Promise((resolve, reject) => {
                                    const req = indexedDB.open('ps_edit_handles', 1);
                                    req.onupgradeneeded = () => req.result.createObjectStore('handles');
                                    req.onsuccess = () => resolve(req.result);
                                    req.onerror = () => reject(req.error);
                                });
                                const savedHandle = await new Promise((resolve) => {
                                    const tx = db.transaction('handles', 'readonly');
                                    const req = tx.objectStore('handles').get('dir');
                                    req.onsuccess = () => resolve(req.result || null);
                                    req.onerror = () => resolve(null);
                                });
                                if (savedHandle) {
                                    console.log('[PS拦截] 从IndexedDB恢复目录句柄');
                                    const perm = await savedHandle.queryPermission({ mode: 'readwrite' });
                                    if (perm === 'granted') {
                                        window.__psEditDirHandle = savedHandle;
                                        return savedHandle;
                                    }
                                    const requested = await savedHandle.requestPermission({ mode: 'readwrite' });
                                    if (requested === 'granted') {
                                        window.__psEditDirHandle = savedHandle;
                                        return savedHandle;
                                    }
                                }
                            } catch (e) {
                                console.warn('[PS拦截] IndexedDB恢复失败:', e);
                            }
                            
                            // 首次使用，弹出选择
                            console.log('[PS拦截] 需要选择目录');
                            const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                            window.__psEditDirHandle = dirHandle;
                            
                            // 存储到 IndexedDB
                            try {
                                const db = await new Promise((resolve, reject) => {
                                    const req = indexedDB.open('ps_edit_handles', 1);
                                    req.onupgradeneeded = () => req.result.createObjectStore('handles');
                                    req.onsuccess = () => resolve(req.result);
                                    req.onerror = () => reject(req.error);
                                });
                                const tx = db.transaction('handles', 'readwrite');
                                tx.objectStore('handles').put(dirHandle, 'dir');
                                console.log('[PS拦截] 目录句柄已存储到IndexedDB');
                            } catch (e) {
                                console.warn('[PS拦截] IndexedDB存储失败:', e);
                            }
                            return dirHandle;
                        }
                        
                        getDirHandle().then(dirHandle => {
                            saveFile(dirHandle, targetFileName, blob);
                        }).catch(err => {
                            console.error('[PS拦截] 获取目录失败:', err);
                        });
                    };
                    reader.readAsArrayBuffer(blob);
                })
                .catch(err => console.error('[PS拦截] fetch blob 失败:', err));
        }
    }, true);

    const originalCreateElement = document.createElement;
    document.createElement = function(tagName) {
        const element = originalCreateElement.call(this, tagName);
        if (tagName.toLowerCase() === 'a') {
            const originalSetAttribute = element.setAttribute.bind(element);
            element.setAttribute = function(name, value) {
                if (name === 'download') {
                    console.log('[PS拦截] 创建了带 download 属性的 a 标签');
                }
                originalSetAttribute(name, value);
            };
        }
        return element;
    };

    const originalOpen = window.open;
    window.open = function(url, name, features) {
        if (typeof url === 'string' && url.startsWith('blob:')) {
            console.log('[PS拦截] window.open 打开 blob URL:', url);
            fetch(url)
                .then(res => res.blob())
                .then(blob => {
                    if (blob.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = function() {
                            const arrayBuffer = reader.result;
                            const uint8 = new Uint8Array(arrayBuffer);
                            let format = 'png';
                            if (uint8.length > 2 && uint8[0] === 0xFF && uint8[1] === 0xD8) {
                                format = 'jpg';
                            } else if (uint8.length > 8 && uint8[0] === 0x89 && uint8[1] === 0x50) {
                                format = 'png';
                            }
                            window.postMessage({
                                type: 'PS_EDIT_SAVE_FSA',
                                data: arrayBuffer,
                                fileName: 'image.' + format
                            }, '*');
                        };
                        reader.readAsArrayBuffer(blob);
                    }
                })
                .catch(err => console.error('[PS拦截] fetch blob URL 失败:', err));
        }
        return originalOpen.apply(this, arguments);
    };
}

function injectMessageBridge() {
    console.log('[PS拦截] 消息桥已注册');
    // 注入到 Photopea ISOLATED world：chrome.runtime.id 仍是发起注入的扩展 ID
    const EXT_ID = chrome.runtime.id;
    window.addEventListener('message', (event) => {
        // L2：仅接受本窗口内 Photopea 页面自身的消息（防其他页面/扩展伪造 PS_EDIT_SAVE）
        if (event.source !== window || event.origin !== 'https://www.photopea.com') return;
        if (event.data && event.data.type === 'PS_EDIT_SAVE') {
            console.log('[PS拦截] 收到 PS_EDIT_SAVE 消息');
            chrome.runtime.sendMessage(EXT_ID, {
                action: 'psEditSave',
                data: event.data.data
            });
        }
        if (event.data && event.data.type === 'PS_EDIT_SAVE_FSA') {
            console.log('[PS拦截] 收到 PS_EDIT_SAVE_FSA 消息，format:', event.data.format, 'rowNum:', event.data.rowNum, 'fileName:', event.data.fileName);
            chrome.runtime.sendMessage(EXT_ID, {
                action: 'psEditSaveFsa',
                data: event.data.data,
                format: event.data.format,
                rowNum: event.data.rowNum,
                fileName: event.data.fileName
            });
        }
    });
}

function parsePsSaveData(arrayBuffer) {
    try {
        const uint8 = new Uint8Array(arrayBuffer);
        const jsonPad = 2000;
        const headerBytes = uint8.slice(0, jsonPad);
        let jsonStr = '';
        for (let i = 0; i < headerBytes.length; i++) {
            if (headerBytes[i] === 0) break;
            jsonStr += String.fromCharCode(headerBytes[i]);
        }
        jsonStr = jsonStr.replace(/\0/g, '').trim();
        const jsonEnd = jsonStr.lastIndexOf('}');
        if (jsonEnd === -1) return null;
        const meta = JSON.parse(jsonStr.slice(0, jsonEnd + 1));

        const versions = meta.versions || [];
        const pngVer = versions.find(v => v.format === 'png' || v.format === 'jpg');
        if (!pngVer) return null;

        const imgStart = jsonPad + pngVer.start;
        const imgEnd = imgStart + pngVer.size;
        const imgData = uint8.slice(imgStart, imgEnd);

        return { meta, imgData, format: pngVer.format };
    } catch (e) {
        console.error('解析PS保存数据失败:', e);
        return null;
    }
}

async function handlePsEditSave(arrayBuffer) {
    if (!psEditState || psEditState.saved) return;

    const parsed = parsePsSaveData(arrayBuffer);
    if (!parsed) {
        console.error('❌ 解析PS保存数据失败');
        return;
    }

    const { imgData, format } = parsed;
    const { fileName, rowNum } = psEditState;

    psEditState.saved = true;
    console.log('✅ PS编辑完成，准备发送回页面:', fileName);

    const uint8Array = Array.from(imgData);

    chrome.runtime.sendMessage(EXTENSION_ID, {
        action: 'psEditComplete',
        rowNum,
        fileName,
        imgData: uint8Array,
        format
    }).catch(() => {});
}

// 扩展自身 ID：动态获取，避免换电脑/重新加载扩展时 ID 变化导致失效
const EXTENSION_ID = chrome.runtime.id;

const PS_EDIT_RESULT_KEY = 'ps_edit_result';

async function handlePsEditSaveFsa(data, fileName) {
    console.log('[PS编辑] handlePsEditSaveFsa 被调用，psEditState:', psEditState);
    if (!psEditState || psEditState.saved) {
        console.log('[PS编辑] psEditState 无效或已保存');
        return;
    }

    let uint8;
    if (typeof data === 'string') {
        console.log('[PS编辑] 收到base64数据，长度:', data.length);
        const binary = atob(data);
        uint8 = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            uint8[i] = binary.charCodeAt(i);
        }
    } else {
        uint8 = new Uint8Array(data);
    }
    let format = 'png';
    if (uint8.length > 2 && uint8[0] === 0xFF && uint8[1] === 0xD8) {
        format = 'jpg';
    } else if (uint8.length > 8 && uint8[0] === 0x89 && uint8[1] === 0x50) {
        format = 'png';
    }

    const { rowNum } = psEditState;
    psEditState.saved = true;
    console.log('✅ PS编辑完成(FSA方式)，准备保存结果:', fileName, 'format:', format, 'rowNum:', rowNum, '数据大小:', uint8.length);

    const uint8Array = Array.from(uint8);

    const result = {
        rowNum,
        fileName: psEditState.fileName,
        imgData: uint8Array,
        format,
        timestamp: Date.now()
    };

    chrome.storage.local.set({ [PS_EDIT_RESULT_KEY]: result }, () => {
        console.log('[PS编辑] 结果已保存到 storage');
    });

    chrome.runtime.sendMessage(EXTENSION_ID, {
        action: 'psEditComplete',
        ...result
    }).catch(() => {});
}

