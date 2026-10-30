importScripts('directory-store.js');
importScripts('upload/publication-images.js');
importScripts('upload/page2_upload.js', 'upload/page3_upload.js', 'suite/suite-task.js', 'suite/suite-core.js', 'suite/suite-native-input.js');

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
const publicationRequests=new Map();
const pageDirectoryRequests=new Map();
let assistantBridgeReady=false;
// 超时参数可被测试注入（globalThis.PAGE_DIR_ACK_MS / PAGE_DIR_TIMEOUT_MS），生产用默认值
const PAGE_DIR_ACK_MS=(typeof globalThis.PAGE_DIR_ACK_MS==='number'&&globalThis.PAGE_DIR_ACK_MS)||5000;
const PAGE_DIR_TIMEOUT_MS=(typeof globalThis.PAGE_DIR_TIMEOUT_MS==='number'&&globalThis.PAGE_DIR_TIMEOUT_MS)||60000;
function pageDirectoryRequest(request){return new Promise((resolve,reject)=>{
    if(!assistantPort)return reject(Error('请先打开看板页面，在页面配置目录'));
    const requestId='directory_'+Date.now()+'_'+Math.random().toString(36).slice(2);
    const timer=setTimeout(()=>{pageDirectoryRequests.delete(requestId);reject(Error('页面目录操作超时，请检查页面是否仍然打开'));},PAGE_DIR_TIMEOUT_MS);
    // 5 秒内页面必须先确认收到（ack）；不确认 = 页面没有目录桥监听或主线程长时间阻塞。
    // 注意：不以「是否已握手」作为门槛——页面 connect 后第一条消息可能先于监听注册到达而被丢弃，
    // 用 ack 判定页面是否真的能接请求，避免把正常页面误判成旧版。
    const ackTimer=setTimeout(()=>{
        const pending=pageDirectoryRequests.get(requestId);
        if(!pending||pending.acked)return;
        pageDirectoryRequests.delete(requestId);clearTimeout(timer);
        reject(Error('看板页面未及时响应目录请求：请重试；若持续出现，请刷新（F5）发品助手页面'));
    },PAGE_DIR_ACK_MS);
    pageDirectoryRequests.set(requestId,{resolve,reject,timer,ackTimer,acked:false});
    try{assistantPort.postMessage({action:'pageDirectoryRequest',requestId,request});}catch(e){clearTimeout(timer);clearTimeout(ackTimer);pageDirectoryRequests.delete(requestId);reject(e);}
});}
// 长连接端口消息里与目录桥相关的部分：握手、逐请求 ack、最终响应。
// 独立成函数，便于从 background.js 切片做隔离验证。
function handleBridgePortMessage(port,msg){
    if(msg.action==='pageDirectoryBridgeReady'&&assistantPort===port)assistantBridgeReady=true;
    if(msg.action==='pageDirectoryAck'&&assistantPort===port){
        if(!assistantBridgeReady)assistantBridgeReady=true;   // 能 ack 就说明页面支持目录桥
        const pending=pageDirectoryRequests.get(msg.requestId);
        if(pending){clearTimeout(pending.ackTimer);pending.acked=true;}
    }
    if(msg.action==='pageDirectoryResponse'&&assistantPort===port){
        const pending=pageDirectoryRequests.get(msg.requestId);
        if(pending){clearTimeout(pending.timer);clearTimeout(pending.ackTimer);pageDirectoryRequests.delete(msg.requestId);msg.ok?pending.resolve(msg.result):pending.reject(Error(msg.error||'页面目录操作失败'));}
    }
}
const publicationUploadLocks=new Set();
function readPublicationGenerated(request){
    return new Promise((resolve,reject)=>{
        if(!assistantPort){reject(Error('请先打开本项目发品助手页面以读取生成套图'));return;}
        const requestId='publication_'+Date.now()+'_'+Math.random().toString(36).slice(2);
        const timer=setTimeout(()=>{publicationRequests.delete(requestId);reject(Error('读取生成套图超时，请检查发品助手页面'));},60000);
        publicationRequests.set(requestId,{resolve,reject,timer});
        try{assistantPort.postMessage({action:'publicationImagesRequest',requestId,...request});}
        catch(e){clearTimeout(timer);publicationRequests.delete(requestId);reject(e);}
    });
}

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

function normalizeHelperPath(value) {
    let path=String(value||'').trim();
    if(/^file:/i.test(path)){
        const url=new URL(path);
        if(url.protocol!=='file:')return '';
        path=decodeURIComponent(url.pathname);
        if(url.hostname&&url.hostname!=='localhost')path='\\\\'+url.hostname+path;
        if(/^\/[a-z]:\//i.test(path))path=path.slice(1);
    }
    return path.replace(/\//g,'\\').toLowerCase();
}
// H1 第1层：外部消息来源校验（Chrome 提供的 sender.url 不可伪造）
async function isTrustedSender(sender) {
    const url = sender?.url || '';
    // 注意：扩展自身页面走 onMessage（内部消息），不会进入 onMessageExternal；
    // 此处出现的 chrome-extension:// 来源只可能是其他扩展，一律拒绝（review blocking 修复）
    // 本机辅助服务的同一助手页；不放行任意 localhost 页面或其他端口。
    try {
        const page = new URL(url);
        if (page.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(page.hostname) && page.port === '8765' && !page.username && !page.password && decodeURIComponent(page.pathname) === '/发品助手.html') return true;
    } catch (_) {}
    if (!url.startsWith('file://')) return false;
    let path;
    try {
        path = normalizeHelperPath(url);
        if(!path)return false;
    } catch (e) {
        console.warn('[isTrustedSender] 非法 file:// URL，拒绝:', url);
        return false;
    }
    // 优先精确匹配 popup 已配置的 helperPath（发品助手.html 的本地路径）
    const helper = await new Promise(r => chrome.storage.local.get(HELPER_PATH_KEY, v => r(v[HELPER_PATH_KEY] || '')));
    if (helper) {
        let helperNorm;
        try{helperNorm=normalizeHelperPath(helper);}catch(_){return false;}
        const pathLower = path.toLowerCase();
        if (pathLower === helperNorm) return true; // 绝对路径：完整相等
        if (!helperNorm.includes('\\') && !helperNorm.includes(':')) {
            // 相对路径（仅文件名）：结尾匹配
            return pathLower.endsWith('\\' + helperNorm) || pathLower.endsWith('/' + helperNorm);
        }
        return false;
    }
    // 没有精确配置时只允许标准助手文件名，不能以目录或文件名子串放行。
    return path.split('\\').pop().toLowerCase() === '发品助手.html';
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
// 点击保存后等待平台反馈的时长：太短采不到 toast/红字，太长拖慢批量。测试里置 0。
const SAVE_VERIFY_WAIT_MS = 2500;
const PUBLISH_LEGACY_UPLOADED_KEY = 'polo_publish_legacy_uploaded'; // 旧 uploaded 标记：历史待核，仅供展示
const PUBLISH_TICK_MS = 30000;                          // 运行期资源巡检间隔上限
// 扩展自己点保存后的「自记账窗口」时长（内存，不落盘）：
// CDP 注入的点击在渲染器里 isTrusted === true，页3 的点击监听会把它当成用户手动点击再回传一次
// recordPublishSaveClick；第二条会把第一条的 unverified / 判失败不写记录 覆盖成 verified。
// 8 秒 = 保存锁内校验 2.5s + 排队余量 + 页面回传延迟，足够覆盖整条回声链路。
const AUTO_SAVE_CLICK_TTL_MS = 8000;
// 页面侧标记（window.__poloAutoSaveAt）有效期：只用于吞掉紧接着的那次注入点击，越短越不易误挡真人点击。
const AUTO_SAVE_PAGE_MARK_MS = 3000;

const PUBLISH_DEFAULTS = {
    batchSize: 50,          // 每批款数默认值（用户可在界面上改）
    rowTimeoutMs: 600000    // 单行超时 10 分钟
};
const PUBLISH_BATCH_MIN = 1;    // 每批最少 1 款
const PUBLISH_BATCH_MAX = 500;  // 每批最多 500 款

// 每批款数收敛：空/非数字 → 默认 50；小于 1 → 1；大于 500 → 500；其余原样
function clampBatchSize(v) {
    if (v === null || v === undefined || v === '') return PUBLISH_DEFAULTS.batchSize;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return PUBLISH_DEFAULTS.batchSize;
    if (n < PUBLISH_BATCH_MIN) return PUBLISH_BATCH_MIN;
    return Math.min(PUBLISH_BATCH_MAX, n);
}

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
            const saved = r[PUBLISH_SETTINGS_KEY] || {};
            const settings = { ...PUBLISH_DEFAULTS, ...saved };
            settings.batchSize = clampBatchSize(saved.batchSize);   // 用户设几就是几（夹到 1-500）
            delete settings.pageLimit;
            resolve(settings);
        });
    });
}

async function setPublishSettings(patch) {
    return withPublishLock(async () => {
        const cur = await getPublishSettings();
        const next = { ...cur, ...patch };
        // 只有明确传了 batchSize 才改；不传则保留当前值（不再无条件覆盖成 50）
        next.batchSize = clampBatchSize((patch && patch.batchSize !== undefined) ? patch.batchSize : cur.batchSize);
        delete next.pageLimit;
        next.rowTimeoutMs = Math.max(60000, parseInt(next.rowTimeoutMs, 10) || PUBLISH_DEFAULTS.rowTimeoutMs);
        await new Promise(r => chrome.storage.local.set({ [PUBLISH_SETTINGS_KEY]: next }, r));

        // 暂停中的任务：立即同步为"下一批"的设置（运行中不改当前批次，避免计数错乱）
        const t = await loadPublishTask();
        if (t && t.state === 'paused') {
            t.batchSize = next.batchSize;
            t.rowTimeoutMs = next.rowTimeoutMs;
            await savePublishTask(t);
        }
        return next;
    });
}

// ---------- 任务持久化 ----------
async function loadPublishTask() {
    const task = await new Promise((resolve) => {
        chrome.storage.local.get(PUBLISH_TASK_KEY, (r) => resolve(r[PUBLISH_TASK_KEY] || null));
    });
    if (!task) return null;
    delete task.pageLimit;
    if (task.batchSize === undefined || task.batchSize === null) {
        // 老任务没有该字段：用当前设置值补上（不再强制改成 50）
        const s = await getPublishSettings();
        task.batchSize = s.batchSize;
    } else {
        task.batchSize = clampBatchSize(task.batchSize);
    }
    if (task.state === 'paused' && ['memory', 'monitorFail', 'pageLimit'].includes(task.pauseReason)) {
        task.pauseReason = 'manual';
        task.pauseDetail = `上次任务已暂停，等待你继续（每批 ${task.batchSize} 款，无需内存服务）`;
        task.resourceBlockDetail = '';
    }
    return task;
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
    // 未确认的保存：数量仍计入 savedCount（用户定义：点了保存即记账），但单独暴露出来便于核对
    const unverifiedSavedCount = Object.keys(savedMap)
        .filter(row => (!taskRows || taskRows.has(row)) && isUnverifiedSave(savedMap[row])).length;
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
        unverifiedSavedCount,
        // 已保存过、被页3 跳过重填的行数：这些行既不算"已填"，也不算"待保存"
        skippedCount: (t && Array.isArray(t.skippedRows)) ? t.skippedRows.length : 0,
        pauseReason: t ? t.pauseReason : '',
        pauseDetail: t ? t.pauseDetail : '',
        // 行失效状态与资源暂停原因分开：界面按 rowRetryable 决定是否显示重试/跳过
        currentRowFailure: t ? (t.currentRowFailure || '') : '',
        rowRetryable: !!(t && t.currentRow !== null && rowFailureOf(t)),
        rowRetries: t ? (t.currentRowRetries || 0) : 0,
        resourceBlockDetail: t ? (t.resourceBlockDetail || '') : '',
        currentRow: t ? t.currentRow : null,
        pages,
        // 仅用于面板显示的分母（页面 N/M），不参与任何判断：没有开页硬闸，到上限只提示不拦。
        pageLimit: PUBLISH_BATCH_MAX
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

// 未确认的保存记录：点了保存但页面上既没成功反馈也没报错（例如提交后异步校验还没结束）。
// 语义：草稿重复保存 ≠ 重复发布，所以这类行「允许重发时重填」，不当成"已保存过"跳过。
function isUnverifiedSave(entry) {
    return !!(entry && entry.unverified === true);
}

// 保存后在页面上采集反馈信号。必须是自包含函数（会被序列化进页3执行），不能引用外部变量。
// 返回：{ error, success, navigated, buttonGone, buttonDisabled, signals[] }
async function saveVerifyProbe(waitMs) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = { error: false, success: false, navigated: false, buttonGone: false, buttonDisabled: false, signals: [] };
    const txt = el => el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const visible = el => {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        let st = null;
        try { st = window.getComputedStyle(el); } catch (_) {}
        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)) return false;
        return true;
    };
    const redText = el => {
        try {
            const st = window.getComputedStyle(el);
            const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(st.color || '');
            if (!m) return false;
            return Number(m[1]) >= 150 && Number(m[2]) <= 110 && Number(m[3]) <= 110;
        } catch (_) { return false; }
    };
    // 明确的校验错误文案（故意不含"请输入/请选择"：这两句大量出现在常驻占位提示里，会误判）
    // HARD_TEXT：自身就能定性为校验失败（必填类语义只出现在真报错里）
    const HARD_TEXT = /必填|不能为空|格式不正确/;
    // SOFT_TEXT：「请上传/上传失败」在阿里发品页是常驻提示（"请上传主图/建议白底图"），
    // 纯文案命中会把每一款都判成校验失败。必须同时有 error 类/红字/父项 has-error 才算失败，
    // 否则只记进 signals 当诊断（formWarnText），不影响结论。
    const SOFT_TEXT = /请上传|上传失败/;
    const ERR_TOAST = /失败|错误|异常/;
    const OK_TOAST = /保存成功|已保存|操作成功/;
    const url0 = location.href;
    // 同一个信号每轮都会命中，去重后再累积（否则 2.5s 窗口能把 signals 刷满重复项）
    const pushSignal = (s) => {
        const v = String(s || '').slice(0, 80);
        if (v && out.signals.indexOf(v) < 0) out.signals.push(v);
    };
    const saveButtons = () => Array.from(document.querySelectorAll('button')).filter(b => txt(b) === '保存');
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (true) {
        for (const help of Array.from(document.querySelectorAll('.next-form-item-help,[class*="form-item-help"]'))) {
            if (!visible(help)) continue;
            const t = txt(help);
            if (!t) continue;
            const item = help.closest ? help.closest('.next-form-item,[class*="form-item"]') : null;
            const hard = String(help.className || '').includes('error') || redText(help)
                || (!!item && String(item.className || '').includes('error'));
            if (hard || HARD_TEXT.test(t)) {
                out.error = true;
                pushSignal('formError:' + t.slice(0, 40));
                break;
            }
            // 只有"常驻提示"文案、没有任何报错样式 → 诊断信号，不判失败
            if (SOFT_TEXT.test(t)) pushSignal('formWarnText:' + t.slice(0, 40));
        }
        for (const el of Array.from(document.querySelectorAll('[class*="toast"],[class*="notification"],[class*="Message"],[class*="Notification"],[role="alert"]'))) {
            if (!visible(el)) continue;
            const t = txt(el);
            if (!t || t.length > 80) continue;
            if (ERR_TOAST.test(t)) { out.error = true; pushSignal('errorToast:' + t.slice(0, 40)); }
            else if (OK_TOAST.test(t)) { out.success = true; pushSignal('successToast:' + t.slice(0, 40)); }
        }
        if (location.href !== url0) { out.navigated = true; pushSignal('url:' + String(location.href).slice(0, 60)); }
        const now = saveButtons();
        if (now.length === 0) { out.buttonGone = true; pushSignal('buttonGone'); }
        else if (now.every(b => !!b.disabled)) { out.buttonDisabled = true; pushSignal('buttonDisabled'); }
        // 只有「明确报错 / 明确成功 / 已跳转」才提前结束轮询。
        // buttonGone / buttonDisabled 只是"提交已生效"的旁证，不能 break：点保存后按钮往往
        // 0-200ms 就 disabled，一 break 整个 2.5s 窗口就作废了，异步返回的拒绝文案永远采不到。
        if (out.error || out.success || out.navigated) break;
        if (Date.now() >= deadline) break;
        await sleep(200);
    }
    return out;
}

// 信号 → 结论。明确报错优先于成功（同一时刻既飘红又跳转时，宁可让人工核对也不算已保存）。
function decideSaveVerification(raw) {
    if (!raw || typeof raw !== 'object') return { verified: false, failure: false, signals: [] };
    const signals = Array.isArray(raw.signals) ? raw.signals.slice(0, 8) : [];
    if (raw.error) return { verified: false, failure: true, signals };
    if (raw.success) return { verified: true, failure: false, signals };
    return { verified: false, failure: false, signals };
}

// 校验本身跑不起来（标签已跳走/调试上下文失效/无 scripting 权限）→ 先看是不是"提交后跳转"，
// 不是的话按"无法确认"处理，不能当明确失败。
async function readTabUrl(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        return (tab && tab.url) || '';
    } catch (_) { return ''; }
}

async function verifyPublishSaved(tabId, beforeUrl) {
    let raw = null;
    try {
        const results = await chrome.scripting.executeScript({ target: { tabId }, args: [SAVE_VERIFY_WAIT_MS], func: saveVerifyProbe });
        raw = (results && results[0]) ? results[0].result : null;
    } catch (e) {
        const nowUrl = await readTabUrl(tabId);
        if (beforeUrl && nowUrl && nowUrl !== beforeUrl) {
            // 提交成功后页面跳走/重载会销毁执行上下文，URL 变化本身就是成功信号
            return { verified: true, failure: false, signals: ['url:' + String(nowUrl).slice(0, 60)] };
        }
        console.warn('⚠️ 保存校验未能执行，按未确认处理：' + e.message);
        await appendPublishLog({ level: 'saveVerifyError', error: e.message });
        return { verified: false, failure: false, signals: [] };
    }
    return decideSaveVerification(raw);
}

// ---------- 自记账窗口：挡住「扩展自己点的保存」被页3 二次记账 ----------
// 语义：background 亲自 CDP 点保存时先登记一个 (fileKey,row) 窗口；随后到达的
// recordPublishSaveClick（clickButton === false，只可能来自页3 的点击监听）若命中未消费的窗口，
// 就是这次注入点击的回声 —— 丢弃，不写任何保存记录，也不动 unverified。
// 一次性消费：窗口命中后立刻移除，真人随后再点保存（哪怕几秒内）不会被连坐。
const autoSaveSelfClicks = new Map();

function autoSaveClickKey(fileKey, row) {
    return String(fileKey === null || fileKey === undefined ? '' : fileKey) + '\u0000' + String(row);
}

function removeAutoSaveToken(token) {
    if (!token) return;
    if (token.timer) { clearTimeout(token.timer); token.timer = null; }
    const list = autoSaveSelfClicks.get(token.key);
    if (!list) return;
    const i = list.indexOf(token);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) autoSaveSelfClicks.delete(token.key);
}

// 登记窗口（必须在 CDP 点击之前）。baseline：点击前页面记录的「已吞掉的注入点击」计数。
function pushAutoSaveSelfClick(fileKey, row, baseline) {
    const key = autoSaveClickKey(fileKey, row);
    const token = { key, row: Number(row), at: Date.now(), baseline: (typeof baseline === 'number' ? baseline : null), timer: null };
    const list = autoSaveSelfClicks.get(key) || [];
    list.push(token);
    // 同一行短时间内最多留 4 个未消费窗口，防异常情况下无界增长
    while (list.length > 4) removeAutoSaveToken(list[0]);
    autoSaveSelfClicks.set(key, list);
    // 到期自清：保证任何路径（成功/失败/异常/页面没回传）都不会永久挡住真人点击
    token.timer = setTimeout(() => removeAutoSaveToken(token), AUTO_SAVE_CLICK_TTL_MS);
    return token;
}

// 消费一个窗口：返回 true 表示这条记账是扩展自己点击的回声
function consumeAutoSaveSelfClick(fileKey, row) {
    const list = autoSaveSelfClicks.get(autoSaveClickKey(fileKey, row));
    if (!list || list.length === 0) return false;
    const token = list[0];
    const expired = Date.now() - token.at > AUTO_SAVE_CLICK_TTL_MS;
    removeAutoSaveToken(token);   // 命中或过期都清，绝不留着挡下一次
    return !expired;
}

// 在页面上打标记（点击之前）：页3 的点击监听见到 3 秒内的标记就 return，不二次记账。
// 返回值 = 点击前页面已吞掉的注入点击计数（取不到返回 null，只靠内存窗口兜底）。
async function markAutoSaveInPage(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId }, args: [AUTO_SAVE_PAGE_MARK_MS],
            func: (markMs) => {
                try {
                    window.__poloAutoSaveAt = Date.now();
                    window.__poloAutoSaveMarkMs = Number(markMs) || 3000;
                } catch (_) {}
                return Number(window.__poloAutoSaveHits || 0);
            }
        });
        const v = results && results[0] ? results[0].result : null;
        return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    } catch (_) { return null; }
}

// 点击后确认页3 是否已自己吞掉这次注入点击：吞掉了就不会再回传，内存窗口可立即撤掉，
// 免得"页3 已挡住 + 内存窗口还在"把用户紧接着的真人点击也挡掉。
async function confirmAutoSaveSwallowedInPage(tabId, token) {
    if (!token || token.baseline === null) return false;
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => Number(window.__poloAutoSaveHits || 0)
        });
        const v = results && results[0] ? results[0].result : null;
        if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        if (v > token.baseline) { removeAutoSaveToken(token); return true; }
        return false;
    } catch (_) { return false; }
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

        // 回声拦截：clickButton === false 只可能来自页3 的点击监听。
        // 命中扩展自己刚点出来的窗口 → 直接丢弃（不写记录、不改 unverified、不广播），
        // 否则它会覆盖第一条的 unverified / 把平台拒绝的那一行写成已保存。
        if (!clickButton && consumeAutoSaveSelfClick(fileKey, row)) {
            console.log(`ℹ️ 第 ${row} 行：忽略扩展自动保存的自记账回声（窗口期内），保存记录不变`);
            return { ok: true, ignored: true, reason: 'auto-save-window', row, fileKey };
        }

        const beforeUrl = String((sender.tab && sender.tab.url) || sender.url || '');
        let clicked;
        let autoSaveToken = null;
        if (clickButton) {
            // 打标记 → 点击：顺序不能反，页3 监听靠"新鲜的标记"识别这次注入点击
            const baseline = await markAutoSaveInPage(tabId);
            autoSaveToken = pushAutoSaveSelfClick(fileKey, row, baseline);
            clicked = await realClickCDP(tabId, x, y);
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
            if (!clicked.ok) {
                removeAutoSaveToken(autoSaveToken);   // 没点成 → 窗口立刻撤掉，别挡住真人点击
                return { ok: false, error: '保存按钮未点击，未标记已保存' };
            }
            // 页3 已自己吞掉这次注入点击 → 不会再有回声，窗口可以提前撤掉
            await confirmAutoSaveSwallowedInPage(tabId, autoSaveToken);
        } else {
            clicked = { ok: true };
        }
        // 点成功 ≠ 保存成功：平台可能只飘红不跳转。先采集反馈，再决定记不记账。
        // recordPublishSaveClick（人工点击）不校验：报错用户自己看得见，且旧行为是"点了就记"。
        const verdict = clickButton
            ? await verifyPublishSaved(tabId, beforeUrl)
            : { verified: true, failure: false, signals: [] };
        if (verdict.failure) {
            console.warn(`⚠️ 第 ${row} 行保存后被平台拒绝，未标记已保存：${verdict.signals.join(' | ') || '（无详情）'}`);
            await appendPublishLog({ level: 'saveRejected', row, fileKey, signals: verdict.signals });
            return { ok: false, error: '平台校验未通过，未标记已保存', row, fileKey, source: 'page3_save_click', verified: false, signals: verdict.signals };
        }
        // 内容不完整（FAQ/介绍模板/箱规/属性缺项）的保存：照样落记录，但标记 unverified，
        // 这样重跑时不会被"已保存过"跳过 —— 真机 62/71/74/78 就是这么被卡住、再也填不上的。
        const incomplete = request.incomplete === true;
        const unverified = !verdict.verified || incomplete;
        const stored = await new Promise(resolve => chrome.storage.local.get(PUBLISH_VERIFIED_SAVED_KEY, resolve));
        const all = stored[PUBLISH_VERIFIED_SAVED_KEY] || {};
        const record = { at: Date.now(), source: 'page3_save_click', taskId: request.taskId || null, verified: verdict.verified };
        if (unverified) record.unverified = true;
        if (incomplete) record.incomplete = true;
        all[fileKey] = { ...(all[fileKey] || {}), [row]: record };
        await new Promise((resolve, reject) => chrome.storage.local.set({ [PUBLISH_VERIFIED_SAVED_KEY]: all }, () => {
            if (chrome.runtime.lastError) reject(new Error('已点击保存，但保存记录写入失败：' + chrome.runtime.lastError.message));
            else resolve();
        }));
        // 未确认时把采集到的诊断信号（含 formWarnText：常驻「请上传主图」这类纯文案）一起打出来，
        // 人工核对该行时能看出「为什么没判成功、为什么也没判失败」。
        if (unverified) console.warn(`⚠️ 第 ${row} 行保存未确认（既无成功反馈也无报错），已记账但允许重发重填，请人工核对`
            + (verdict.signals.length ? `：${verdict.signals.join(' | ')}` : ''));
        notifyAssistant('publishSaved', { row, fileKey, source: 'page3_save_click', verified: verdict.verified, unverified });
        await broadcastPublishState();
        return { ok: true, row, fileKey, source: 'page3_save_click', verified: verdict.verified, unverified, signals: verdict.signals };
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

// 手动暂停：立即闸停并关闭当前产品页（填入中断，未保存的行仍留在队列头部，继续时重发该产品）
async function pausePublishTaskManual() {
    markPublishStop();
    return withPublishLock(async () => {
        const t = await loadPublishTask();
        if (t && t.state !== 'done') {
            const tabId = t.currentTabId;
            t.currentRow = null;
            t.currentTabId = null;
            t.currentStartedAt = 0;
            t.currentRowRetries = 0;
            t.currentRowFailure = '';
            t.resourceBlockDetail = '';
            await savePublishTask(t);
            if (tabId !== null && tabId !== undefined) {
                try { await chrome.tabs.remove(tabId); } catch (_) {}
            }
        }
        await pausePublishTaskLocked('manual', '用户手动暂停：当前产品已停止填入；点「继续」重新发该产品');
    });
}

// 回收：发品内容不保存即全部丢弃，关闭当前产品页，任务不可恢复
async function discardPublishTask() {
    markPublishStop();
    return withPublishLock(async () => {
        const t = await loadPublishTask();
        const tabId = t ? t.currentTabId : null;
        const row = t ? t.currentRow : null;
        await savePublishTask(null);
        stopPublishTick();
        if (tabId !== null && tabId !== undefined) {
            try { await chrome.tabs.remove(tabId); } catch (_) {}
        }
        await appendPublishLog({ level: 'discard', row });
        await broadcastPublishState();
        return { ok: true };
    });
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

    // 继续 = 当前产品重新发一遍：关闭上次未完成的页面并复位当前行（行未 shift，仍是 remaining[0]）
    if (t.currentRow !== null) {
        const oldTabId = t.currentTabId;
        t.currentRow = null;
        t.currentTabId = null;
        t.currentStartedAt = 0;
        t.currentRowRetries = 0;
        t.currentRowFailure = '';
        t.resourceBlockDetail = '';
        if (oldTabId !== null && oldTabId !== undefined) {
            try { await chrome.tabs.remove(oldTabId); } catch (_) {}
        }
        await savePublishTask(t);
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

    // 继续前同步最新设置（每批款数 / 行超时），使界面上改的批次真正生效
    const s = await getPublishSettings();
    t.batchSize = s.batchSize;
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
    // 本批「填满」才暂停（用已填完数，不是已开页数）：这样暂停时当前套已完成，
    // 点继续自然从下一套开始，不会重上最后一款。
    if ((t.batchFilledDone || 0) >= t.batchSize) {
        await pausePublishTaskLocked('batch', `本批已填满 ${t.batchFilledDone}/${t.batchSize} 套，剩 ${t.remaining.length} 款；点「继续」从下一套开始`);
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
        // 队列首行一致性：shift() 会删队列头部，若首行不是本行就会删错行（该行既不在待填也不在已完成，
        // 等于静默丢行，且后续 remaining[0] 永远对不上 currentRow → 任务卡死）。此校验必须在任何状态修改之前。
        if (!Array.isArray(t.remaining) || t.remaining.length === 0 || Number(t.remaining[0]) !== Number(row)) {
            return { ok: false, message: `队列首行 ${t.remaining && t.remaining[0]} 与 ${row} 不一致，已拒绝（防止删错行）` };
        }

        // 已保存过的行被页3 跳过重填：单独记账，不冒充"已填"。
        // 旧行为把它算进 filledCount/filledRows，于是一批全跳过时面板显示"已填 100/100 · 待保存 0"，
        // 实际 0 份草稿。skip 只推进队列，填/保存两类计数都不动。
        const isSkipped = msg.skipped === true;

        // 记录填写完成。暂停中也接受：当前页的有效完成必须入账，只是不自动开新页。
        const wasPaused = t.state === 'paused';
        t.remaining.shift();
        if (isSkipped) {
            if (!Array.isArray(t.skippedRows)) t.skippedRows = [];
            if (!t.skippedRows.some(r => Number(r) === Number(row))) t.skippedRows.push(row);
        } else {
            t.filledCount += 1;
            if (!Array.isArray(t.filledRows)) t.filledRows = [];
            t.filledRows.push(row);
            t.batchFilledDone = (t.batchFilledDone || 0) + 1;
        }
        t.currentRow = null;
        t.currentTabId = null;
        t.currentStartedAt = 0;
        t.currentRowRetries = 0;   // 该行已入账，重试计数归零
        t.currentRowFailure = '';  // 行已成功填写，失效状态清除
        t.resourceBlockDetail = '';
        await savePublishTask(t);
        await appendPublishLog({ level: isSkipped ? 'skipped' : 'filled', row, skipped: isSkipped, filled: t.filledCount, remain: t.remaining.length, batchFilled: t.batchFilledDone, paused: wasPaused });

        if (t.remaining.length === 0) {
            t.state = 'done';
            t.pauseReason = '';
            t.pauseDetail = '';
            await savePublishTask(t);
            stopPublishTick();
            await appendPublishLog({ level: 'done', filled: t.filledCount, skipped: (t.skippedRows || []).length, total: t.total });
            notifyAssistant('publishAllFilled', { filled: t.filledCount, skipped: (t.skippedRows || []).length, total: t.total });
            await broadcastPublishState();
            return { ok: true, done: true, skipped: isSkipped };
        }

        notifyAssistant('publishFilledAck', { row, skipped: isSkipped, filled: t.filledCount, total: t.total, remaining: t.remaining.length });
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
        // 与 onPublishFilled 同一条守卫：shift() 删的是队列头部，首行不是当前行就会删错行
        // （该行既不在待填也不在已跳过 → 静默丢行，后续 remaining[0] 永远对不上 currentRow）。
        // 必须在任何状态修改之前拒绝。
        if (!Array.isArray(t.remaining) || t.remaining.length === 0 || Number(t.remaining[0]) !== Number(row)) {
            return { ok: false, message: `队列首行 ${t.remaining && t.remaining[0]} 与当前行 ${row} 不一致，已拒绝（防止删错行）` };
        }
        t.remaining.shift();
        if (!Array.isArray(t.skippedRows)) t.skippedRows = [];
        t.skippedRows.push(row);
        // 跳过也算本批处理完一套：保持「已开 / 已处理」两个计数一致，避免显示「已开 51/50」
        t.batchFilledDone = (t.batchFilledDone || 0) + 1;
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
    // 图片以磁盘为准：先按页面句柄读 <文件名>/rowN/rowN_<color>.png，读到就直接用 dataUrl 上传。
    // 读不到（未授权/文件不存在）才回落到旧记录逻辑，兼容历史数据。
    fetchColorImageAsBase64(rowNum, color, undefined, context.fileFolder).then(r => {
        if (r && r.ok && r.dataUrl) { callback({ ok: true, url: r.dataUrl, dataUrl: r.dataUrl, fromDisk: true, path: null }); return; }
        getColorImagePathDataLegacy(rowNum, color, callback, context);
    }).catch(() => getColorImagePathDataLegacy(rowNum, color, callback, context));
}
function getColorImagePathDataLegacy(rowNum, color, callback, context) {
    if (typeof PoloDirectories !== 'undefined' && PoloDirectories.isColorSelection(context.colorImgDir)) {
        PoloDirectories.colorImage(context.colorImgDir,context.fileFolder,rowNum,color)
            .then(url => callback({ok:true,url,path:null}))
            .catch(async error => {
                // 临时权限待确认时，已有的同文件图片缓存仍可用于展示与上传。
                try {
                    const cached = await getColorImageFromIDB(colorImageIDBKey(context.fileFolder === DEFAULT_FILE_FOLDER ? '' : context.fileFolder,rowNum,color));
                    if (cached) {callback({ok:true,url:cached,path:null});return;}
                } catch (_) {}
                callback({ok:false,error:error.message});
            });
        return;
    }
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

// ---------- 套图输出目录桥 ----------
// 输出目录句柄只存在于扩展源（PoloExtensionDirectories/picker-color-img-dir），跨源无法把句柄交给 file:// 页面。
// 因此由扩展在自身源使用既有「🖼️ 产品套图目录」句柄执行套图【写入 + 回读校验】，再经既有受信任消息桥返回结果。
// 不新增任何路径配置：唯一配置就是扩展里已有的那个目录入口。
const SUITE_OUTPUT_SEGMENT_RE = /^[^\\/:*?"<>|\u0000]{1,40}$/;                 // 子目录路径段：不含分隔符与非法字符
// 允许两种命名：① 输出编号（111/222/333/444/666.png，当前约定）；② 旧 suite_ 前缀（兼容历史成品）
const SUITE_OUTPUT_FILE_RE = /^(?:suite_[a-zA-Z0-9\u4e00-\u9fff._-]{1,140}|(?:111|222|333|444|666))\.(png|jpg|jpeg|webp)$/i;

function suiteOutputRec() {
    return PoloDirectories.pickerRecord('color-img-dir');
}

// 子目录名是纯参数校验：不依赖目录是否已配置，非法输入先失败（不触碰文件系统）。
// 支持多级相对路径（如「<文件名>/row3」），与颜色图按 fileName/rowN 归类的子目录层级同构；
// 只允许 `/` 作分隔，拒绝反斜杠、绝对路径、`.`/`..`/空段与非法字符，杜绝路径穿越。
function suiteOutputSubdir(subdir) {
    if (subdir === undefined || subdir === null || subdir === '') return null;
    const raw = String(subdir);
    if (raw.length > 120) throw new Error('输出子目录路径过长：' + raw);
    if (raw.includes('\\')) throw new Error('非法输出子目录（不允许反斜杠）：' + raw);
    const segs = [];
    for (const part of raw.split('/')) {
        const p = String(part).trim();
        if (p === '' || p === '.' || p === '..') throw new Error('非法输出子目录段：' + part);
        if (!SUITE_OUTPUT_SEGMENT_RE.test(p)) throw new Error('非法输出子目录段：' + part);
        segs.push(p);
    }
    if (segs.length === 0) return null;
    return segs.join('/');
}

// 输出通道选择。目录授权（File System Access）是【会话级】的：扩展后台(service worker)休眠、
// 扩展重载、浏览器重启之后权限一律回落为 prompt，而后台没有用户手势、无法调用 requestPermission。
// 因此不再把「权限必须是 granted」当硬闸门，改为二选一（目录未配置才报错）：
//   fs        → 权限仍为 granted：沿用原有最严格的「写入 → 关闭流 → 重新读取 → 校验大小/类型/解码/指纹」
//   downloads → 权限回落：改走 chrome.downloads 落到「下载/<已保存目录名>/[子目录]/」，不需要任何授权
// 两条都落到真实磁盘；目录名仍取自扩展里已保存的那个句柄，不新增任何路径配置。
async function suiteOutputPlan(subdir) {
    const seg = suiteOutputSubdir(subdir);
    const rec = await suiteOutputRec();
    // 统一路径模式：没有句柄记录时，直接用颜色图目录（绝对路径）的目录名作为下载根，
    // 套图与颜色图落在同一目录（下载/<颜色图目录名>/<文件名>/rowN/），无需任何授权。
    if (!rec || !rec.handle) {
        const dirPath = String(COLOR_IMG_DIR || '');
        const base = dirPath.replace(/[\/]+$/, '').split(/[\/]/).pop();
        if (dirPath && !dirPath.startsWith('polo-dir:') && base && SUITE_OUTPUT_SEGMENT_RE.test(base)) {
            return { mode: 'downloads', root: base, seg, relPrefix: seg ? `${base}/${seg}/` : `${base}/`, permission: 'none' };
        }
        throw new Error('套图输出目录未配置：请在扩展里把颜色图目录填成绝对路径（套图会写入同一目录）');
    }
    let perm = 'denied';
    try { perm = await rec.handle.queryPermission({ mode: 'readwrite' }); } catch (_) { perm = 'denied'; }
    if (perm === 'granted') {
        let dir = rec.handle;
        // 多级相对路径（<文件名>/rowN）：逐级创建子目录，与颜色图子目录层级一致
        if (seg) for (const part of seg.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
        return { mode: 'fs', dir, dirName: rec.name || '' };
    }
    const root = String(rec.name || '').trim();
    if (!root || !SUITE_OUTPUT_SEGMENT_RE.test(root)) {
        throw new Error(`套图输出目录权限为 ${perm}，且已保存的目录名「${root}」不能作为下载子目录：请在扩展中展开该项并点击保存确认权限`);
    }
    return { mode: 'downloads', root, seg, relPrefix: seg ? `${root}/${seg}/` : `${root}/`, permission: perm };
}

function suiteDataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('结果图片数据格式非法（应为 base64 data URL）');
    const bin = atob(m[2]);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: m[1] || 'image/png' });
}

async function suiteSwDecodeSize(blobOrFile) {
    const b = await createImageBitmap(blobOrFile);
    try { return { width: b.width, height: b.height }; } finally { if (b.close) b.close(); }
}

async function suiteSwContentHash(blobOrFile) {
    const bytes = await crypto.subtle.digest('SHA-256', await blobOrFile.arrayBuffer());
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

// 状态查询：只报告配置与权限，不写任何文件。
// 只要目录已配置（有句柄记录），就一定能落盘：权限在 → 磁盘句柄；权限回落 → 下载通道降级。
async function suiteOutputStatus() {
    const rec = await suiteOutputRec();
    if (!rec || !rec.handle) {
        // 统一路径模式：没有句柄时用颜色图目录（绝对路径）的目录名作为下载根，
        // 套图与颜色图同目录（下载/<颜色图目录名>/<文件名>/rowN/），无需任何授权。
        const dirPath = String(COLOR_IMG_DIR || '');
        const base = dirPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        if (dirPath && !dirPath.startsWith('polo-dir:') && base && SUITE_OUTPUT_SEGMENT_RE.test(base)) {
            return { configured: true, name: base, permission: 'none', canFallback: true, fallbackTarget: '下载/' + base, mode: 'downloads' };
        }
        return { configured: false, name: '', permission: 'none', canFallback: false, mode: 'none', message: '套图输出目录未配置：请把颜色图目录填成绝对路径（套图会写入同一目录）' };
    }
    let perm = 'unknown';
    try { perm = await rec.handle.queryPermission({ mode: 'readwrite' }); } catch (_) { perm = 'denied'; }
    const canFallback = perm !== 'granted' && !!String(rec.name || '').trim() && SUITE_OUTPUT_SEGMENT_RE.test(String(rec.name).trim());
    return {
        configured: true, name: rec.name || '', permission: perm, canFallback,
        fallbackTarget: canFallback ? '下载/' + rec.name : '',
        mode: perm === 'granted' ? 'fs' : (canFallback ? 'downloads' : 'none')
    };
}

// ---- 下载通道（无需任何目录授权）：blob → data URL、按 id 等待落盘、路径比对 ----
async function suiteSwBlobToDataUrl(blob) {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

function suiteDownloadSearch(query) {
    return new Promise((resolve, reject) => {
        try {
            chrome.downloads.search(query, (items) => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(err.message)); else resolve(items || []);
            });
        } catch (e) { reject(e); }
    });
}

// 等待下载真正结束（complete / interrupted），最多 timeoutMs；超时如实返回未完成状态。
async function suiteAwaitDownload(id, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const item = (await suiteDownloadSearch({ id }))[0] || null;
        if (item && (item.state === 'complete' || item.state === 'interrupted')) return item;
        if (Date.now() >= deadline) return item || { id, state: 'missing', filename: '', error: '等待下载结果超时' };
        await new Promise(r => setTimeout(r, 300));
    }
}

// 降级写盘：校验级别如实标注为 download-record（下载记录 state=complete 且记录大小与写入前一致），
// 与 fs 模式的「回读解码校验」不是同一级别，绝不冒充。
async function suiteWriteViaDownloads(plan, items) {
    const results = [];
    for (const it of items) {
        const base = { key: it.key, filename: it.filename, saved: false, bytes: 0, error: '' };
        try {
            const bytes = it.blob.size;
            let size = null;
            try { size = await suiteSwDecodeSize(it.blob); } catch (_) { size = null; }
            const contentHash = await suiteSwContentHash(it.blob);
            const dataUrl = await suiteSwBlobToDataUrl(it.blob);
            const relPath = plan.relPrefix + it.filename;
            // 与既有颜色图下载流程同一套机制：download() 之前先把目标相对路径预登记到
            // downloadFilenameMap，由 chrome.downloads.onDeterminingFilename 监听器 suggest() 该路径。
            // 不登记的话监听器会走 suggest() 空参分支，落盘名字就变成「下载 - 时间戳.png」。
            const preKey = 'pre:' + dataUrl;
            downloadFilenameMap.set(preKey, { filename: it.filename, relativePath: relPath, url: dataUrl });
            const id = await new Promise((resolve, reject) => {
                chrome.downloads.download({ url: dataUrl, filename: relPath, conflictAction: 'overwrite', saveAs: false }, (downloadId) => {
                    downloadFilenameMap.delete(preKey);            // 命中后监听器也可能已消费该条目
                    const err = chrome.runtime.lastError;
                    if (err) reject(new Error(err.message));
                    else if (downloadId === undefined || downloadId === null) reject(new Error('下载未返回任务号'));
                    else {
                        downloadFilenameMap.set(downloadId, { filename: it.filename, relativePath: relPath, url: dataUrl });
                        resolve(downloadId);
                    }
                });
            });
            const item = await suiteAwaitDownload(id);
            downloadFilenameMap.delete(id);
            const savedPath = String((item && item.filename) || '');
            const matchesTarget = savedPath.replace(/\\/g, '/').endsWith(relPath);
            const state = (item && item.state) || 'missing';
            if (state === 'complete' && matchesTarget && (!item.fileSize || item.fileSize === bytes)) {
                results.push(Object.assign(base, { saved: true, bytes, width: size && size.width, height: size && size.height, contentHash, downloadId: id, downloadState: state, savedPath, error: '' }));
            } else {
                const why = state !== 'complete' ? `下载未完成（state=${state}${item && item.error ? '，' + item.error : ''}）`
                    : (matchesTarget ? `下载记录大小不一致（${item.fileSize} ≠ ${bytes}）` : `落盘路径与预期不符（${savedPath}）`);
                results.push(Object.assign(base, { bytes, error: why, contentHash, downloadId: id, downloadState: state, savedPath }));
            }
        } catch (e) {
            results.push(Object.assign(base, { error: '下载写入失败：' + ((e && e.message) || e) }));
        }
    }
    const allSaved = results.length > 0 && results.every(r => r.saved);
    return {
        ok: allSaved, results,
        savedCount: results.filter(r => r.saved).length,
        failedKeys: results.filter(r => !r.saved).map(r => r.key),
        retrySaveOnly: !allSaved,
        mode: 'downloads', verification: 'download-record', fallback: true, dirName: plan.root,
        savedPaths: results.filter(r => r.savedPath).map(r => r.savedPath),
        note: `产品套图目录未授权，已走下载通道落盘到「下载/${plan.root}/」（按下载记录校验，非磁盘回读解码）`
    };
}

// 降级核验：按下载记录核对。下载历史跨会话保留，故必须排除「早于本次保存时间」的旧记录 ——
// 旧记录不能证明文件现在还在磁盘上。
async function suiteVerifyViaDownloads(plan, mapped) {
    // 按时间倒序取最近的下载记录；某些 Chrome 版本不接受 orderBy，则退化为普通查询（后面仍按 savedAt 过滤）。
    let all = [];
    try { all = await suiteDownloadSearch({ limit: 500, orderBy: ['-startTime'] }); }
    catch (_) { all = await suiteDownloadSearch({ limit: 500 }); }
    const items = mapped.map(m => {
        const base = { key: m.key, filename: m.meta.filename, status: 'error', detail: '' };
        if (!m.meta.filename) return Object.assign(base, { status: 'cache-only', detail: '历史索引缺少文件定位信息，无法核验磁盘' });
        const target = (plan.relPrefix + m.meta.filename).replace(/\\/g, '/');
        const hits = all.filter(d => String(d.filename || '').replace(/\\/g, '/').endsWith(target));
        if (!hits.length) return Object.assign(base, { status: 'missing', detail: '下载记录中未找到该文件' });
        const fresh = m.meta.savedAt ? hits.filter(d => Date.parse(d.startTime || '') >= m.meta.savedAt - 5000) : hits;
        if (!fresh.length) return Object.assign(base, { status: 'missing', detail: '仅找到早于本次保存时间的旧下载记录，无法证明文件仍在磁盘上' });
        const hit = fresh[0];
        if (hit.state !== 'complete') return Object.assign(base, { status: 'error', detail: `下载未完成（state=${hit.state}）` });
        if (!hit.fileSize) return Object.assign(base, { status: 'error', detail: '下载记录没有文件大小，无法校验' });
        if (m.meta.bytes && hit.fileSize !== m.meta.bytes) return Object.assign(base, { status: 'replaced', detail: `大小与保存时不一致（${hit.fileSize} ≠ ${m.meta.bytes}）` });
        return Object.assign(base, { status: 'verified', detail: `下载记录已核验 ${hit.fileSize} 字节（${hit.filename}）` });
    });
    const allOk = items.length > 0 && items.every(i => i.status === 'verified');
    return {
        ok: allOk, items, unverified: items.filter(i => i.status !== 'verified').map(i => i.key),
        mode: 'downloads', verification: 'download-record', fallback: true, dirName: plan.root,
        note: '产品套图目录未授权，本次为下载记录核验（非磁盘回读解码）'
    };
}

// 写入 + 回读校验（写盘后重新读取，校验大小/类型/可解码/尺寸/内容指纹）。
async function suiteWriteOutput(request) {
    const files = Array.isArray(request.files) ? request.files : [];
    if (!files.length) throw new Error('没有要保存的结果图片');
    if (files.length > 20) throw new Error(`一次最多保存 20 张，实际 ${files.length} 张`);
    // 先做纯参数校验（文件名 / 子目录），非法输入立即失败，不触碰文件系统
    const normalized = files.map(f => {
        const filename = String((f && f.filename) || '');
        if (!SUITE_OUTPUT_FILE_RE.test(filename)) throw new Error('非法输出文件名：' + filename);
        return { key: String((f && f.key) || ''), filename, dataUrl: f && f.dataUrl };
    });
    const items = normalized.map(n => ({ key: n.key, filename: n.filename, blob: suiteDataUrlToBlob(n.dataUrl) }));
    const plan = await suiteOutputPlan(request.subdir);
    // 覆盖策略与页面既有设计一致：文件名含 fileKey/行号/任务号，天然防跨文件跨产品覆盖；
    // 同一任务重试保存需能重写同名文件，故此处允许覆盖，仅由文件名白名单约束。
    if (plan.mode === 'fs') {
        const saved = await SuiteCore.saveAll(plan.dir, items, { buildFilename: it => it.filename, decodeSize: suiteSwDecodeSize, hash: suiteSwContentHash });
        return Object.assign(saved, { mode: 'fs', verification: 'disk-readback', fallback: false, dirName: plan.dirName || '', savedPaths: [] });
    }
    return await suiteWriteViaDownloads(plan, items);
}

// 磁盘核验：只读，逐编号回读真实文件。目录不可用时按 no-permission 返回（≠ 文件缺失）。
async function suiteVerifyOutput(request) {
    const records = Array.isArray(request.records) ? request.records : [];
    if (!records.length) return { ok: false, items: [], unverified: [], error: '没有需要核验的记录' };
    const mapped = records.map(r => ({
        key: String(r.key),
        meta: { filename: r.filename || '', bytes: Number(r.bytes) || 0, contentHash: r.contentHash || '', savedAt: Number(r.savedAt) || 0 }
    }));
    let plan = null, planError = '';
    try { plan = await suiteOutputPlan(request.subdir); } catch (e) { planError = e.message; }
    if (!plan) {
        return {
            ok: false, error: planError,
            items: mapped.map(m => ({ key: m.key, filename: m.meta.filename, status: 'no-permission', detail: planError || '输出目录不可用，无法核验（不等于文件缺失）' })),
            unverified: mapped.map(m => m.key)
        };
    }
    if (plan.mode === 'fs') {
        return await SuiteCore.verifySavedFiles(mapped, { dirHandle: plan.dir, decodeSize: suiteSwDecodeSize, hash: suiteSwContentHash });
    }
    return await suiteVerifyViaDownloads(plan, mapped);
}

// ---------- 豆包账号（切号 / 列账号 / 读额度）：转发到豆包内容脚本 ----------
// 只做转发与结果回包，不参与任何换色/套图状态流转。
// 切号会让豆包整页重载，重载会销毁旧文档里的消息通道（sendMessage 抛
// "The message port closed before a response was received."）。这时既不能当失败
// （页面其实已经切过去了），也不能当成功（没核对过），所以等 tab 重载完成后用
// doubaoListAccounts 读一次当前账号名复核，把真实结果回给调用方。
function doubaoAccountSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitDoubaoTabReloaded(tabId, timeout = 25000) {
    const start = Date.now();
    let sawLoading = false;
    while (Date.now() - start < timeout) {
        let tab = null;
        try { tab = await chrome.tabs.get(tabId); } catch (_) { return false; }
        if (!tab) return false;
        if (tab.status === 'loading') sawLoading = true;
        if (sawLoading && tab.status === 'complete') return true;
        // 重载太快、没抓到 loading：给 3s 观察窗后按「已加载完」处理
        if (!sawLoading && tab.status === 'complete' && Date.now() - start > 3000) return true;
        await doubaoAccountSleep(250);
    }
    return false;
}

// 通道被重载关闭后的复核：等重载 → 再等 2s（与内容脚本一致）→ 轮询读账号名比对。
// 豆包冷重载常 >4s，新文档的内容脚本要过一会儿才挂上监听，所以最多轮询 10 次 × 1s。
async function recoverDoubaoAccountSwitch(tabId, name) {
    try {
        const reloaded = await waitDoubaoTabReloaded(tabId);
        if (!reloaded) return { ok: false, reloaded: false, error: '切号后未等到页面重载完成（页面可能已关闭或未重载）' };
        await doubaoAccountSleep(2000);
        let repaired = false;
        // 一次轮询尝试：返回 { list, wallStreak, gotAny }。
        // gotAny=false 表示 10 次一次响应都没拿到 —— 这不是「读错名字」而是「内容脚本根本没活着」，
        // 常见原因是扩展刚更新过，旧标签里的注入脚本失效。此时刷新页面才是唯一验证过的救法。
        const pollOnce = async (times) => {
            let list = null, wallStreak = 0, gotAny = false;
            const seq = [];
            for (let i = 0; i < times; i++) {
                list = await chrome.tabs.sendMessage(tabId, { action: 'doubaoListAccounts' }).catch(() => null);
                const wall = !!(list && list.loginWall === true);
                wallStreak = wall ? wallStreak + 1 : 0;
                if (list) gotAny = true;
                if (list && list.ok) seq.push(list.current || '');
                // 命中目标就立刻收：现在不 break 在「列表读到了」，因为重载后第一次读到的
                // 常常还是上一个账号（账号态比 DOM 晚），拿它比对就是「用户名不匹配」的误报来源。
                if (list && list.ok && list.current === name) return { list, wallStreak, gotAny, seq, hit: true };
                if (wallStreak >= 2) break;   // 连续两次登录墙才认（单次可能是重载瞬间的过渡页）
                if (i < times - 1) await doubaoAccountSleep(1000);   // 新文档的内容脚本可能还没就绪
            }
            return { list, wallStreak, gotAny, seq, hit: false };
        };

        let r = await pollOnce(10);
        if (!r.gotAny) {
            // 一次响应都没拿到 = 内容脚本是死的。刷一次页面重新注入（不是热注入：
            // doubao.js 顶层有 let/const，重复注入会因重复声明直接抛错，且会造成双监听）。
            repaired = true;
            try { await chrome.tabs.reload(tabId); } catch (_) {}
            await waitDoubaoTabReloaded(tabId, 25000);
            await doubaoAccountSleep(2000);
            r = await pollOnce(5);
        }
        // 登录墙优先于一切：ok:true 的名字可读的墙也不能当切号成功
        if (r.list && r.list.loginWall === true) {
            return { ok: false, needLogin: true, reloaded: true, repaired, expect: name, actualSeq: r.seq };
        }
        if (!r.list || !r.list.ok) {
            return { ok: false, reloaded: true, repaired, infra: true, expect: name, actualSeq: r.seq,
                error: (repaired ? '自动刷新豆包页面后仍读不到账号列表：' : '重载后读不到账号列表：')
                    + ((r.list && r.list.error) || '内容脚本无响应（扩展刚更新时常见，手动刷新豆包标签页即可恢复）') };
        }
        if (r.hit) return { ok: true, name, reloaded: true, repaired, expect: name, actualSeq: r.seq };
        // 轮询了多次都不是目标：把整个读取序列带回给调用方，用来区分
        // 「前几次是旧账号、后来变了但没到目标」（读早了/页面残留）和「一直是同一个别的号」（真切错）。
        return { ok: false, reloaded: true, repaired, actual: r.list.current || '', expect: name, actualSeq: r.seq,
            error: '切换后用户名不匹配（实际：' + (r.list.current || '未知') + '）' };
    } catch (e) {
        return { ok: false, reloaded: true, error: e.message };
    }
}

// ---------- 豆包账号账本（自动切号 / 读账本） ----------
// 为什么编排放在 background：切号会让豆包整页重载，重载销毁内容脚本，
// 只有 background 的上下文能跨重载继续跑完一次切号。
// 账本只落一个键 polo_doubao_accounts_v1，结构：
// { dateKey:'YYYY-MM-DD', updatedAt, accounts: { [name]: { plan,status,percent,label,checkedAt,note,resumeAt,missing,probeSeq,
//                                                     genFailStreak,genFailAt,unsupportedAt } } }
// 可用性判定看 status（exhausted / unsupported 今天都不再当候选，unknown 才是候选）；
// percent / label / resumeAt / genFail* 是诊断字段（genFail* 参与「连续 3 次生成不出图」的记账）。
const DOUBAO_LEDGER_KEY = 'polo_doubao_accounts_v1';
const DOUBAO_STATUS_OK = 'ok';                 // 历史可用标记：当前没有任何代码写入 ok
const DOUBAO_STATUS_EXHAUSTED = 'exhausted';   // 真实任务刚被额度拒 → 自动切号把当前号记成这个
// 连续 DOUBAO_GEN_FAIL_LIMIT 次「一张图都没生成出来」→ 今天判该账号不支持生图（被平台限制的号）
const DOUBAO_STATUS_UNSUPPORTED = 'unsupported';
const DOUBAO_STATUS_UNKNOWN = 'unknown';       // 未测/超时/异常/需登录，绝不当成 ok
const DOUBAO_GEN_FAIL_LIMIT = 3;               // 连续生成失败几次判定「不支持生图」
const DOUBAO_GEN_DEDUPE_MS = 8000;             // 同一次失败会被内容脚本与页面各报一次，窗口内只记一次
const DOUBAO_CHANNEL_CLOSED_RE = /message port closed|Receiving end does not exist|message channel closed|Could not establish connection/i;
let doubaoScanInFlight = false;   // 自动切号重入闸（同一时刻只允许一轮）
let doubaoGenLastReport = null;   // { name, row, ok, at }：生成结果双上报去重用
// 同一行的失败只记一次的标记（内容脚本+页面双报、超时重试、整批补跑都会对同一行重复上报，
// 不按行去重的话一次超时就能被记成 2-3 次，好号会被冤枉）。内存态即可：账本里另有跨天的 genFailStreak。
let doubaoGenCountedRows = new Set();   // '账号\0行号'

// 本地日期键（YYYY-MM-DD）：额度按自然日刷新，跨天必须把旧结论作废
function doubaoLocalDateKey(ts) {
    const d = (typeof ts === 'number' && ts > 0) ? new Date(ts) : new Date();
    const p = n => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function doubaoEmptyLedger() { return { dateKey: doubaoLocalDateKey(), updatedAt: 0, accounts: {} }; }

function doubaoNormStatus(s) {
    return (s === DOUBAO_STATUS_OK || s === DOUBAO_STATUS_EXHAUSTED || s === DOUBAO_STATUS_UNSUPPORTED
        || s === DOUBAO_STATUS_UNKNOWN) ? s : DOUBAO_STATUS_UNKNOWN;
}

// 读账本：任何脏数据都收敛成合法结构，读失败返回空账本（不抛）
// 跨天处理：dateKey 不是今天就说明账本里全是「昨天甚至更早」的结论 —— 额度已刷新、
// 平台的生图限制也按自然日重新观察，把 status 全部重置为 unknown 并把
// genFailStreak / genFailAt / unsupportedAt 一起清零（保留 name/plan/missing/probeSeq），落盘后返回。
async function doubaoLoadLedger() {
    try {
        const today = doubaoLocalDateKey();
        const r = await chrome.storage.local.get(DOUBAO_LEDGER_KEY);
        const raw = r && r[DOUBAO_LEDGER_KEY];
        const ledger = doubaoEmptyLedger();
        if (!raw || typeof raw !== 'object') return ledger;
        ledger.dateKey = typeof raw.dateKey === 'string' ? raw.dateKey : '';
        ledger.updatedAt = Number(raw.updatedAt) || 0;
        const src = (raw.accounts && typeof raw.accounts === 'object') ? raw.accounts : {};
        for (const name of Object.keys(src)) {
            const v = src[name];
            if (!v || typeof v !== 'object' || !name) continue;
            ledger.accounts[name] = {
                plan: typeof v.plan === 'string' ? v.plan : '',
                status: doubaoNormStatus(v.status),
                percent: (typeof v.percent === 'number' && Number.isFinite(v.percent)) ? v.percent : null,
                label: typeof v.label === 'string' ? v.label : '',
                checkedAt: Number(v.checkedAt) || 0,
                note: typeof v.note === 'string' ? v.note : '',
                resumeAt: typeof v.resumeAt === 'string' ? v.resumeAt : '',
                missing: v.missing === true,
                probeSeq: Number(v.probeSeq) || 0,
                genFailStreak: Math.max(0, Number(v.genFailStreak) || 0),
                genFailAt: Number(v.genFailAt) || 0,
                unsupportedAt: Number(v.unsupportedAt) || 0
            };
        }
        if (ledger.dateKey !== today) {
            for (const name of Object.keys(ledger.accounts)) {
                const a = ledger.accounts[name];
                a.status = DOUBAO_STATUS_UNKNOWN;
                a.percent = null;
                a.label = '';
                a.checkedAt = 0;
                a.note = 'dayRefresh';
                a.resumeAt = '';
                a.genFailStreak = 0;
                a.genFailAt = 0;
                a.unsupportedAt = 0;
            }
            ledger.dateKey = today;
            await doubaoSaveLedger(ledger);
        }
        return ledger;
    } catch (e) {
        console.warn('[doubao ledger] 读取失败，按空账本处理:', e.message);
        return doubaoEmptyLedger();
    }
}

async function doubaoSaveLedger(ledger) {
    try {
        const out = { dateKey: doubaoLocalDateKey(), updatedAt: Date.now(), accounts: {} };
        if (ledger && typeof ledger.dateKey === 'string' && ledger.dateKey) out.dateKey = ledger.dateKey;
        const src = (ledger && ledger.accounts) || {};
        for (const name of Object.keys(src)) {
            const v = src[name] || {};
            out.accounts[name] = {
                plan: typeof v.plan === 'string' ? v.plan : '',
                status: doubaoNormStatus(v.status),
                percent: (typeof v.percent === 'number' && Number.isFinite(v.percent)) ? v.percent : null,
                label: typeof v.label === 'string' ? v.label : '',
                checkedAt: Number(v.checkedAt) || 0,
                note: typeof v.note === 'string' ? v.note : '',
                resumeAt: typeof v.resumeAt === 'string' ? v.resumeAt : '',
                missing: v.missing === true,
                probeSeq: Number(v.probeSeq) || 0,
                genFailStreak: Math.max(0, Number(v.genFailStreak) || 0),
                genFailAt: Number(v.genFailAt) || 0,
                unsupportedAt: Number(v.unsupportedAt) || 0
            };
        }
        ledger.updatedAt = out.updatedAt;
        ledger.dateKey = out.dateKey;
        await chrome.storage.local.set({ [DOUBAO_LEDGER_KEY]: out });
        return true;
    } catch (e) {
        console.warn('[doubao ledger] 写入失败:', e.message);
        return false;
    }
}

// 带超时的内容脚本调用：避免页面重载/卡死时整轮切号无限挂住
function doubaoSendToTab(tabId, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error('豆包页面响应超时'));
        }, timeoutMs || 30000);
        let p;
        try { p = chrome.tabs.sendMessage(tabId, payload); }
        catch (e) { clearTimeout(timer); if (!done) { done = true; reject(e); } return; }
        Promise.resolve(p).then(
            v => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
            e => { if (done) return; done = true; clearTimeout(timer); reject(e); }
        );
    });
}

// 发品/换色/套图是否在跑（复用既有判据：套图执行锁 + 换色执行身份 + 内容脚本忙态）
// 返回结构化状态（调用方一律只认 .busy）：
//   processing  真在跑任务（执行锁/在途换色/内容脚本 isProcessing）
//   domBusy     套图生成中（套图不设 isProcessing，只能看 DOM 忙类）
//   quotaRecent 内容脚本 30s 内刚被额度拒过 → 它已按规则忽略 DOM 忙信号，
//               这里如实透传，页面日志才能区分「真在生成」和「额度气泡把换号挡住了」
async function doubaoIsAccountBusy() {
    const state = { busy: false, processing: false, domBusy: false, quotaRecent: false };
    try { if (globalThis.__suiteExecLock) { state.busy = true; state.processing = true; return state; } } catch (_) {}
    try {
        const exec = await getActiveColorExec();
        if (exec && (exec.state === 'pending' || exec.state === 'accepted')) {
            state.busy = true;
            state.processing = true;
            return state;
        }
    } catch (_) {}
    try {
        const tab = await findDoubaoTab();
        if (tab) {
            const st = await doubaoSendToTab(tab.id, { action: 'doubaoBusyState' }, 8000).catch(() => null);
            if (st && st.ok === true) {
                state.quotaRecent = st.quotaRecent === true;
                state.processing = state.processing || st.processing === true;
                state.domBusy = st.domBusy === true;
                state.busy = state.busy || state.processing || state.domBusy;
            }
        }
    } catch (_) {}
    return state;
}

// 单次切号（含重载断通道的复核）。返回内容脚本原语的结果，或 ok:false+needLogin/busy/error
async function doubaoSwitchForScan(tabId, name) {
    try {
        const resp = await doubaoSendToTab(tabId, { action: 'doubaoSwitchAccount', name }, 45000);
        return resp || { ok: false, error: '豆包页面无返回' };
    } catch (e) {
        const msg = String((e && e.message) || '');
        if (DOUBAO_CHANNEL_CLOSED_RE.test(msg)) {
            // 正常路径：点完账号行页面就重载了，通道先死，再复核真实账号名
            return await recoverDoubaoAccountSwitch(tabId, name);
        }
        return { ok: false, error: msg };
    }
}

// 说明：账本里的可用性结论只有两个来源，都不做任何独立探测：
//   ① 页面上的真实任务刚被额度拒 → doubaoAutoSwitchAction 把该号记 exhausted
//   ② 其余一律 unknown（没切过去 / 超时 / 需登录都不等于没额度）
// 因此账本实际只会出现 exhausted / unknown，没有代码会写 ok。

function doubaoNextProbeSeq(ledger) {
    let max = 0;
    const acc = (ledger && ledger.accounts) || {};
    for (const name of Object.keys(acc)) max = Math.max(max, Number(acc[name] && acc[name].probeSeq) || 0);
    return max + 1;
}

function doubaoWriteProbe(ledger, name, outcome, plan) {
    if (!ledger.accounts[name]) ledger.accounts[name] = {};
    const a = ledger.accounts[name];
    a.plan = plan || a.plan || '';
    a.status = doubaoNormStatus(outcome.status);
    a.percent = (typeof outcome.percent === 'number' && Number.isFinite(outcome.percent)) ? outcome.percent : null;
    a.label = outcome.label || '';
    a.note = outcome.note || '';
    a.resumeAt = outcome.resumeAt || '';
    a.checkedAt = Date.now();
    a.missing = false;
    a.probeSeq = doubaoNextProbeSeq(ledger);
}

// 列表 → 账本合并：新出现的账号写 unknown（不探测，只登记）；
// 账本里有但本轮列表没有的保留并标 missing:true，不删（账号可能是被折叠/暂时没渲染）
function doubaoMergeAccountList(ledger, accounts) {
    const seen = new Set();
    for (const a of (accounts || [])) {
        const name = a && a.name ? String(a.name) : '';
        if (!name) continue;
        seen.add(name);
        let cur = ledger.accounts[name];
        if (!cur) {
            ledger.accounts[name] = {
                plan: typeof a.plan === 'string' ? a.plan : '',
                status: DOUBAO_STATUS_UNKNOWN, percent: null, label: '',
                checkedAt: 0, note: 'new', missing: false, probeSeq: 0,
                genFailStreak: 0, genFailAt: 0, unsupportedAt: 0
            };
        } else {
            cur.missing = false;
            if (!cur.plan && typeof a.plan === 'string' && a.plan) cur.plan = a.plan;
        }
    }
    for (const name of Object.keys(ledger.accounts)) {
        if (!seen.has(name)) ledger.accounts[name].missing = true;
    }
    return ledger;
}

async function doubaoReadCurrentName(tabId) {
    try {
        const list = await doubaoSendToTab(tabId, { action: 'doubaoListAccounts' }, 20000);
        return (list && list.ok && list.current) ? String(list.current) : '';
    } catch (_) { return ''; }
}

// 当天已判「不可用」的号：exhausted（弹额度）与 unsupported（连续 3 次生成不出图）同等对待 ——
// 今天都不再当候选。只有确实是今天试出来的才算，跨天（额度/平台限制按自然日重新观察）不得沿用。
function doubaoIsFreshExhausted(a) {
    if (!a || (a.status !== DOUBAO_STATUS_EXHAUSTED && a.status !== DOUBAO_STATUS_UNSUPPORTED)) return false;
    const ts = Number(a.checkedAt) || 0;
    if (!ts) return false;
    return doubaoLocalDateKey(ts) === doubaoLocalDateKey();
}

function doubaoProbeOrder(x, y) {
    return (x[1].probeSeq - y[1].probeSeq) || (x[1].checkedAt - y[1].checkedAt);
}

// 候选顺序：先 status=ok，再 unknown（没测过/结论未知）—— 两态都是可切候选，ok 只是排前面。
// 跳过：missing（列表里点不到）、exclude、当天已判 exhausted / unsupported（两种原因分开返回，日志能区分）。
// 返回 { order:[name], skipped:[name], skippedExhausted:[name], skippedUnsupported:[name], present:[[name,acc]] }
function doubaoBuildCandidates(ledger, exclude) {
    const ex = new Set((exclude || []).map(s => String(s == null ? '' : s).trim()).filter(Boolean));
    const present = Object.entries((ledger && ledger.accounts) || {})
        .filter(([n, a]) => a && a.missing !== true && !ex.has(n));
    const okList = present.filter(([, a]) => a.status === DOUBAO_STATUS_OK).sort(doubaoProbeOrder);
    const unknown = present.filter(([, a]) => a.status === DOUBAO_STATUS_UNKNOWN).sort(doubaoProbeOrder);
    const blocked = present.filter(([, a]) => doubaoIsFreshExhausted(a));
    const skippedExhausted = blocked.filter(([, a]) => a.status === DOUBAO_STATUS_EXHAUSTED).map(([n]) => n);
    const skippedUnsupported = blocked.filter(([, a]) => a.status !== DOUBAO_STATUS_EXHAUSTED).map(([n]) => n);
    return {
        order: okList.concat(unknown).map(([n]) => n),
        skipped: skippedExhausted.concat(skippedUnsupported),
        skippedExhausted,
        skippedUnsupported,
        present
    };
}

// 一次性自动切号：只切号，不探测 —— 切到第一个能切过去的候选就返回。
//
// 为什么不再「试生图」：调用本动作的唯一场景是「当前号刚弹额度」，页面拿到成功结果后
// 会自己重跑**当前这一款真实任务**。于是额度结论只由「真实任务有没有再次被拒」回填：
//   出图        → 这个号有额度，继续下一款（账本不动：没有任何代码会写 ok）
//   又弹额度    → 页面把这个号记进已试列表，再调本动作换下一个号，重跑同一款
// 也就是说账本实际只会出现 exhausted / unknown，ok 只是结构里留着的状态值。
// 试生图除了白烧 1 张图片额度外没有任何信息增量，因此彻底去掉：本函数不发任何生成请求。
//
// 流程：读账本 → 候选排序（ok 在前、unknown 在后，跳过 missing / exclude / 当天已判 exhausted）
//       → 逐个「只切号」：
//          切成功 → 立刻返回 {ok:true,name,scanned:false,ledger}，不再试后面的
//          切失败 → 该号记 unknown + note，接着试下一个（最多把候选试完）
// 全部候选都不行：
//   能点的号全被「当天已判 exhausted」挡住 → {ok:false, reason:'allExhausted'}
//   切号本身失败/需登录（结论未知）        → {ok:false, reason:'none', error}
//   只有「全是 exhausted」才报 allExhausted —— 没切过去不等于没额度。
async function doubaoAutoSwitchAction(request) {
    let ledger = doubaoEmptyLedger();
    const tried = [];
    try {
        if (doubaoScanInFlight) return { ok: false, reason: 'busy', ledger: await doubaoLoadLedger(), tried };
        const busy0 = await doubaoIsAccountBusy();
        if (busy0.busy) {
            // quotaRecent：内容脚本刚被额度拒过、已按规则忽略 DOM 忙信号，页面日志要能区分
            return { ok: false, reason: 'busy', quotaRecent: busy0.quotaRecent, ledger: await doubaoLoadLedger(), tried };
        }

        const tab = await findDoubaoTab();
        if (!tab) return { ok: false, reason: 'none', error: '未找到豆包页面', ledger: await doubaoLoadLedger(), tried };

        const exclude = Array.isArray(request && request.exclude) ? request.exclude.slice() : [];
        ledger = await doubaoLoadLedger();

        // 关键：把"当前正在用的账号"排除掉。
        // 页面侧调用时刚发生额度用完，但账本里这个号可能还写着 ok，
        // 不排除就会把同一个号再切一次 → 页面重跑 → 再命中 → 死循环。
        const cur = await doubaoReadCurrentName(tab.id);
        if (cur) {
            if (exclude.indexOf(cur) < 0) exclude.push(cur);
            // 刚用完额度的号顺手记为 exhausted（除非调用方明确说别动）。
            // 但已经是「连续 3 次生成不出图」的号不能被改写成额度用完：两种不可用原因必须能区分。
            const curRec = ledger.accounts[cur];
            const curUnsupported = !!(curRec && curRec.status === DOUBAO_STATUS_UNSUPPORTED && doubaoIsFreshExhausted(curRec));
            if (curUnsupported) {
                console.log('[doubao ledger] 当前号 ' + cur + ' 已判「不支持生图」，保留该结论（不改写为额度用完）');
            } else if (!request || request.quotaExhausted !== false) {
                doubaoWriteProbe(ledger, cur, { status: DOUBAO_STATUS_EXHAUSTED, percent: null, label: '本批刚用完', note: 'quotaExhausted', resumeAt: '' });
                await doubaoSaveLedger(ledger);
            }
        }

        let cand = doubaoBuildCandidates(ledger, exclude);

        // 账本里一个能点的号都没有（首次使用/账本被清）：先拉一次账号列表，只登记不探测
        if (!cand.present.length) {
            const list = await doubaoSendToTab(tab.id, { action: 'doubaoListAccounts' }, 20000)
                .catch(e => ({ ok: false, error: e.message }));
            if (list && list.loginWall === true) return { ok: false, reason: 'needLogin', ledger, tried };
            if (list && list.ok === true) {
                doubaoMergeAccountList(ledger, list.accounts || []);
                await doubaoSaveLedger(ledger);
                cand = doubaoBuildCandidates(ledger, exclude);
            }
        }
        if (!cand.present.length) {
            const hasAny = Object.keys(ledger.accounts).length > 0;
            return hasAny
                ? { ok: false, reason: 'allExhausted', ledger, tried,
                    skipped: cand.skipped, skippedExhausted: cand.skippedExhausted, skippedUnsupported: cand.skippedUnsupported }
                : { ok: false, reason: 'none', error: '账本里没有可用账号', ledger, tried };
        }
        if (!cand.order.length) {
            // 能点的号全被当天结论挡住：这就是「都不可用」（额度用完 / 不支持生图分开回，日志能区分原因）
            return { ok: false, reason: 'allExhausted', ledger, tried,
                skipped: cand.skipped, skippedExhausted: cand.skippedExhausted, skippedUnsupported: cand.skippedUnsupported };
        }

        let lastError = '';
        doubaoScanInFlight = true;
        try {
            for (const name of cand.order) {
                const busyN = await doubaoIsAccountBusy();
                if (busyN.busy) {
                    return { ok: false, reason: 'busy', quotaRecent: busyN.quotaRecent, error: '发品/换色/套图任务正在进行，暂不切号', ledger, tried };
                }
                // 只切号：不发任何生成请求（不 probe、不试生图、不占额度）
                const sw = await doubaoSwitchForScan(tab.id, name);
                if (sw && sw.busy) {
                    return { ok: false, reason: 'busy', error: sw.error || '豆包正在生成中，暂不切号', ledger, tried };
                }
                if (sw && sw.ok === true) {
                    return { ok: true, name, scanned: false, ledger, tried };
                }
                // 基础设施失败（内容脚本失联/页面读不到）：试再多的号也是同样的结果，
                // 继续循环只会把好号逐个记成 unknown、污染候选排序 —— 立刻收手，如实报 infra。
                const why = sw && sw.needLogin ? 'needLogin' : ((sw && sw.error) || '切号失败');
                if (sw && sw.infra === true) {
                    tried.push({ name, error: why });
                    return { ok: false, reason: 'infra', ledger, tried,
                        expect: sw.expect, actualSeq: sw.actualSeq || [],
                        error: String(why) };
                }
                // 切号失败（含需重新登录）：如实记 unknown，接着试下一个候选
                doubaoWriteProbe(ledger, name, {
                    status: DOUBAO_STATUS_UNKNOWN, percent: null, label: '', resumeAt: '',
                    note: String(why).slice(0, 80)
                }, (ledger.accounts[name] && ledger.accounts[name].plan) || '');
                await doubaoSaveLedger(ledger);
                tried.push({ name, error: why });
                lastError = why;
            }
        } finally {
            doubaoScanInFlight = false;
        }

        // 候选全部切不过去：没有任何「明确没额度」的证据，只能报 none ——
        // 没切过去（需登录/超时/异常）不等于没额度，别把结论未知说成"所有号都没额度"。
        return { ok: false, reason: 'none', error: '账号都切不过去：' + (lastError || '未知原因'), ledger, tried };
    } catch (e) {
        return { ok: false, reason: 'none', error: e.message, ledger, tried };
    }
}

// 生成结果记账的串行闸：读账本 → 改 → 落盘 是「读改写」，同一次失败会被内容脚本和页面
// 几乎同时各报一次，并发进来会各加一次。这里把记账串成一条链，第二条能看到第一条写的去重标记。
let doubaoGenQueue = Promise.resolve();
function doubaoGenResultSerialized(request, tabId) {
    const run = () => doubaoGenResultAction(request, tabId);
    const next = doubaoGenQueue.then(run, run);
    doubaoGenQueue = next.then(() => {}, () => {});
    return next;
}

// 无 UI 入口，供控制台/调试调用：读账本原始内容
async function doubaoGetAccountLedgerAction() {
    const ledger = await doubaoLoadLedger();
    return { ok: true, dateKey: ledger.dateKey, updatedAt: ledger.updatedAt, accounts: ledger.accounts };
}

// 生成结果记账（内容脚本出图/失败各报一次；页面侧失败时也报一次问结论）。
// 规则：
//   出图（ok:true）      → genFailStreak 归零、unsupportedAt 清零；若它当前是 unsupported，恢复成 unknown
//                          （能出图就说明这个号能用，之前的判定作废）
//   生成失败（ok:false） → genFailStreak++ ；连续 DOUBAO_GEN_FAIL_LIMIT 次 → status=unsupported、
//                          unsupportedAt=now、note='genFailed3'（今天不再当候选，页面据此换号）
// 同一次失败会被内容脚本和页面各报一次，用 (账号, 行号) + 时间窗去重，保证「连续 3 次」按真实失败次数算。
// 记账失败绝不抛：返回 {ok:false}，调用方一律按「没被判不可用」继续主流程。
async function doubaoGenResultAction(request, tabId) {
    try {
        const okFlag = !!(request && request.ok === true);
        const row = Number(request && request.row) || 0;
        const reason = String((request && request.reason) || '').slice(0, 120);
        let tid = Number(tabId) || 0;
        if (!tid) {
            // 只有「执行页」知道这次失败属于哪个号。但换色 exec 可能是上一轮遗留的，
            // 所以必须用行号校验：exec.rowNum === 本次上报的 row 才认，否则回退（套图因此自动走回退分支）。
            if (typeof getActiveColorExec === 'function') {
                const ex = await getActiveColorExec();
                if (ex && ex.tabId && Number(ex.rowNum) === row) tid = Number(ex.tabId);
            }
        }
        if (!tid) {
            const tab = await findDoubaoTab();
            if (!tab) return { ok: false, error: '未找到豆包页面' };
            tid = tab.id;
        }
        const name = await doubaoReadCurrentName(tid);
        if (!name) return { ok: false, error: '读不到当前账号名' };
        const ledger = await doubaoLoadLedger();
        if (!ledger.accounts[name]) {
            ledger.accounts[name] = {
                plan: '', status: DOUBAO_STATUS_UNKNOWN, percent: null, label: '',
                checkedAt: 0, note: '', resumeAt: '', missing: false, probeSeq: 0,
                genFailStreak: 0, genFailAt: 0, unsupportedAt: 0
            };
        }
        const a = ledger.accounts[name];
        const now = Date.now();

        if (okFlag) {
            const wasUnsupported = a.status === DOUBAO_STATUS_UNSUPPORTED;
            a.genFailStreak = 0;
            a.genFailAt = 0;
            a.unsupportedAt = 0;
            if (wasUnsupported) {
                a.status = DOUBAO_STATUS_UNKNOWN;
                a.note = 'genOkRecovered';
                console.log('[doubao ledger] ' + name + ' 出图成功 → 解除「不支持生图」判定，恢复 unknown');
            }
            doubaoGenLastReport = { name, row, ok: true, at: now };
            await doubaoSaveLedger(ledger);
            return { ok: true, name, row, streak: 0, disabled: false, recovered: wasUnsupported };
        }

        // 去重：同一行的失败只记一次（行号有效时按「账号+行」终身去重，防重试/补跑重复计数；
        // 行号缺失退回 8 秒窗口兜底，避免把不同失败互相当成重复）。
        const prev = doubaoGenLastReport;
        const rowKey = row > 0 ? (name + '\0' + row) : '';
        const dup = rowKey
            ? doubaoGenCountedRows.has(rowKey)
            : !!(prev && prev.ok === false && prev.name === name && prev.row === row
                && (now - prev.at) < DOUBAO_GEN_DEDUPE_MS);
        if (!dup) {
            if (rowKey) doubaoGenCountedRows.add(rowKey);
            a.genFailStreak = (Number(a.genFailStreak) || 0) + 1;
            a.genFailAt = now;
            if (a.genFailStreak >= DOUBAO_GEN_FAIL_LIMIT) {
                a.status = DOUBAO_STATUS_UNSUPPORTED;
                a.unsupportedAt = now;
                a.checkedAt = now;
                a.note = 'genFailed3';
                console.warn('[doubao ledger] ' + name + ' 连续 ' + a.genFailStreak
                    + ' 次生成不出图 → 今天判定「不支持生图」，不再当候选（原因=' + (reason || '无') + '）');
            } else {
                console.log('[doubao ledger] ' + name + ' 生成失败 ' + a.genFailStreak + '/' + DOUBAO_GEN_FAIL_LIMIT
                    + '（原因=' + (reason || '无') + '）');
            }
            doubaoGenLastReport = { name, row, ok: false, at: now };
            await doubaoSaveLedger(ledger);
        }
        const disabled = a.status === DOUBAO_STATUS_UNSUPPORTED;
        return {
            ok: true, name, row, reason,
            reasonKind: disabled ? 'unsupported' : 'genFail',
            streak: Number(a.genFailStreak) || 0,
            disabled,
            deduped: dup
        };
    } catch (e) {
        console.warn('[doubao ledger] 生成结果记账失败（不影响主流程）:', e.message);
        return { ok: false, error: e.message };
    }
}

// 手动清空账号额度记录（调试/误标时用）：清完所有账号回到 unknown，不影响豆包本身
// 无 UI 入口，供控制台/调试调用
async function doubaoResetAccountLedgerAction() {
    try {
        const empty = doubaoEmptyLedger();
        await doubaoSaveLedger(empty);
        return { ok: true, dateKey: empty.dateKey, updatedAt: empty.updatedAt, accounts: empty.accounts };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function relayDoubaoAccountAction(request) {
    try {
        if (request.action === 'doubaoSwitchAccount' && (typeof request.name !== 'string' || !request.name.trim())) {
            return { ok: false, error: '缺少账号名' };
        }
        const tab = await findDoubaoTab();
        if (!tab) return { ok: false, error: '未找到豆包页面' };
        const payload = { action: request.action };
        if (request.action === 'doubaoSwitchAccount') payload.name = request.name.trim();
        try {
            const resp = await chrome.tabs.sendMessage(tab.id, payload);
            return resp || { ok: false, error: '豆包页面无返回' };
        } catch (e) {
            const msg = String((e && e.message) || '');
            const channelClosed = /message port closed|Receiving end does not exist|message channel closed|Could not establish connection/i.test(msg);
            if (request.action === 'doubaoSwitchAccount' && channelClosed) {
                return await recoverDoubaoAccountSwitch(tab.id, payload.name);
            }
            return { ok: false, error: '豆包页面未响应：' + msg };
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 共享动作分发器：处理 onMessage/onMessageExternal 的 17 种业务动作
// （saveProductData/saveBatchProducts/getProductByRow/openPublishPage/…/getConfig），
// 各动作内直接操作 storage 与目录配置并 sendResponse
async function handleSharedAction(request, sendResponse, sender) {
    if(['listScriptDirectory','readScriptDirectory','psDirectoryStatus','readPsImage','writePsImage','suiteOutputStatus','suiteWriteOutput','suiteVerifyOutput'].includes(request.action)){
        try{sendResponse(await pageDirectoryRequest(request));}catch(e){sendResponse({ok:false,error:e.message});}
        return true;
    }
    if(request.action==='registerPagePaths'){
        if(!await isTrustedSender(sender)){sendResponse({ok:false,error:'来源不符'});return true;}
        const helper=String(sender.url||'').split('?')[0].split('#')[0];
        await chrome.storage.local.set({polo_helper_path:helper});
        sendResponse({ok:true});return true;
    }
    // ---------- 豆包账号：切号 / 列账号（自动换号链路用，发品助手 file:// 页可直接调用） ----------
    if (request.action === 'doubaoSwitchAccount' || request.action === 'doubaoListAccounts') {
        relayDoubaoAccountAction(request).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    // ---------- 豆包账号账本：一次性自动切号 / 读账本 / 清账本 ----------
    if (request.action === 'doubaoAutoSwitch' || request.action === 'doubaoGetAccountLedger'
        || request.action === 'doubaoResetAccountLedger') {
        (async () => {
            if (request.action === 'doubaoAutoSwitch') return await doubaoAutoSwitchAction(request);
            if (request.action === 'doubaoResetAccountLedger') return await doubaoResetAccountLedgerAction();
            return await doubaoGetAccountLedgerAction();
        })().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    // 生成结果记账：内容脚本（出图/失败）与发品助手页（失败时问结论）都走这条
    if (request.action === 'doubaoGenResult') {
        // ⚠️ 只有内容脚本所在的 tab 才是豆包页。发品助手是 externally-connected 的普通网页，
        // 它发来的 sender.tab 是助手页自己的 tab，用它会去助手页要「当前账号名」，永远读不到
        // → disabled 永远为 false → 连续 3 次失败也不会换号。所以这里必须校验来源 URL。
        const srcUrl = String((sender && sender.tab && sender.tab.url) || '');
        const fromDoubaoTab = /^https?:\/\/([a-z0-9-]+\.)*(doubao\.com)\//i.test(srcUrl);
        const tabId = fromDoubaoTab ? sender.tab.id : 0;
        doubaoGenResultSerialized(request, tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'suitePreparePage') {
        try {
            const exec = await getActiveColorExec();
            if (exec && ['accepted', 'pending'].includes(exec.state)) throw Error('换色任务正在执行，请先暂停换色');
            const tab = await prepareSuiteDoubaoPage();
            sendResponse({ok:true,tabId:tab.id});
        } catch(e) { sendResponse({ok:false,error:e.message}); }
        return true;
    }
    if (['listScriptDirectory','readScriptDirectory'].includes(request.action)) {
        try {
            const result = request.action === 'listScriptDirectory' ? await PoloDirectories.scriptDirectoryFiles()
                : await PoloDirectories.scriptDirectoryRead(request.paths,request.revision);
            sendResponse({ok:true,...result});
        } catch(error) {sendResponse({ok:false,error:error.message});}
        return true;
    }

    if (['psDirectoryStatus','readPsImage','writePsImage'].includes(request.action)) {
        try {
            const result = request.action === 'psDirectoryStatus' ? await PoloDirectories.status()
                : request.action === 'readPsImage' ? await PoloDirectories.read(request.fileName)
                : await PoloDirectories.write(request.fileName, request.data, request.format);
            sendResponse({ok:true,...result});
        } catch(e) {sendResponse({ok:false,error:e.message});}
        return true;
    }

    // 套图输出目录桥：由扩展在自身源用既有「产品套图目录」句柄写盘/回读，经消息桥返回结果
    if (['suiteOutputStatus','suiteWriteOutput','suiteVerifyOutput'].includes(request.action)) {
        (async () => {
            try {
                const result = request.action === 'suiteOutputStatus' ? await suiteOutputStatus()
                    : request.action === 'suiteWriteOutput' ? await suiteWriteOutput(request)
                    : await suiteVerifyOutput(request);
                sendResponse({ok:true,...result});
            } catch(e) {sendResponse({ok:false,error:e.message});}
        })();
        return true;
    }

    // ---------- 发品任务控制（发品助手页 file:// 与扩展内部均可） ----------
    if (request.action === 'pausePublishQueue') {
        pausePublishTaskManual().then(() => {
            buildPublishStatePayload().then(p => sendResponse({ ok: true, state: p.state }));
        }).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'resumePublishQueue') {
        resumePublishTask().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'discardPublishTask') {
        discardPublishTask().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
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
        SuiteTaskStore.get(request.taskId).then(t => sendResponse({ ok: true, task: request.summary&&t ? Object.assign({},t,{images:undefined,assets:undefined,prompt:undefined}):t })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'suiteListTasks') {
        SuiteTaskStore.list({ fileKey: request.fileKey, rowNum: request.rowNum, activeOnly: !!request.activeOnly })
            .then(list => sendResponse({ ok: true, tasks: list.map(t=>Object.assign({},t,{images:undefined,assets:undefined,prompt:undefined})) })).catch(e => sendResponse({ ok: false, error: e.message }));
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
                } else if (r.stage === check.task.stage) {
                    task = check.task; // idempotent checkpoint, never resend generation
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
    if(request.action==='suiteRecoverResults') {
        (async()=>{try{
            const task=await SuiteTaskStore.get(request.taskId);
            if(!task||task.cancelled||!task.stageAt.sent)throw new Error('没有可恢复的已发送任务');
            if(task.fileKey!==request.fileKey||task.rowNum!==request.rowNum)throw new Error('恢复任务身份不符');
            const url=task.doubaoUrl||request.recoveryUrl;
            if(!url||!/^https:\/\/(www\.)?doubao\.com\/chat\//.test(url))throw new Error('缺少原豆包对话地址');
            const tabs=await chrome.tabs.query({});let tab=tabs.find(t=>t.url===url);
            if(!tab){tab=await chrome.tabs.create({url,active:true});await new Promise(r=>setTimeout(r,3000));}
            const binding={taskId:task.taskId,fileKey:task.fileKey,rowNum:task.rowNum};
            const bound=await chrome.tabs.sendMessage(tab.id,{action:'suite-recover-bind',binding,baselineUrls:task.baselineUrls||[]});
            if(!bound?.success)throw new Error(bound?.error||'原对话未就绪');
            let result;
            for(let i=0;i<12;i++){
                const response=await chrome.tabs.sendMessage(tab.id,{action:'suite-poll',binding,baselineUrls:task.baselineUrls||[],expectCount:task.expectCount});
                if(!response?.success)throw new Error(response?.error||'读取已有图片失败');
                if(response.result?.ready){result=response.result;break;}
                await new Promise(r=>setTimeout(r,1500));
            }
            if(!result)throw new Error('原对话尚未加载完整结果，未发送新请求');
            const restored=await SuiteTaskStore.recoverResults(task.taskId,{fileKey:request.fileKey,rowNum:request.rowNum},result.images);
            sendResponse({ok:true,taskId:restored.taskId,count:restored.images.length});
        }catch(e){sendResponse({ok:false,error:e.message});}})();return true;
    }
    if (request.action === 'suiteRecover') {
        SuiteTaskStore.recoverOnStartup().then(ids => sendResponse({ ok: true, interrupted: ids })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    /* 套图执行编排：把已创建任务真正送入豆包执行（一次快速五图，不拆分）
       步骤：互斥检查 → 取/建豆包页 → 探测就绪 → 记基线 → 上传素材 →
             输入合并提示词 → 明确发送一次 → 等待本次新结果 → 交页面识别/后处理/保存 */
    if (request.action === 'suiteRun') {
        if(globalThis.__suiteExecLock){sendResponse({ok:false,error:'Suite execution already running'});return false;}
        globalThis.__suiteExecLock={taskId:request.taskId,at:Date.now()};
        sendResponse({ok:true,accepted:true,taskId:request.taskId});
        const reply=()=>{};
        (async () => {
            const taskId=request.taskId;
            const report = (stage, extra) => chrome.runtime.sendMessage(EXTENSION_ID,
                Object.assign({ action: 'suiteProgress', report: Object.assign({ taskId, stage }, extra || {}) }, {})).catch(() => {});
            try {
                const t = await SuiteTaskStore.get(taskId);
                if (!t) { reply({ ok: false, error: '未知任务：' + taskId }); return; }
                if (t.stage !== 'received' || SuiteTaskStore.isTerminal(t.stage)) { reply({ ok: false, error: `任务已终态：${t.stage}` }); return; }

                // 双向互斥①：换色正在执行 → 抢占失败，明确失败而不是排队等待
                const cexec = await getActiveColorExec();
                if (cexec && cexec.state === 'accepted') {
                    await SuiteTaskStore.fail(taskId, '阶段 channel：换色任务正在执行，套图无法占用豆包输入通道');
                    reply({ ok: false, error: '换色任务正在执行，套图无法占用豆包输入通道' });
                    return;
                }
                // 取得套图执行锁（换色启动前会检查它）
                await saveActiveColorExec(null).catch(() => {});
                globalThis.__suiteExecLock = { taskId, at: Date.now() };

                let tab = await prepareSuiteDoubaoPage();
                let tabId = tab.id;   // 页面失联时可能换成新标签
                await chrome.tabs.update(tabId,{active:true});
                await chrome.windows.update(tab.windowId,{focused:true});
                globalThis.__suiteExecLock.tabId = tabId;
                const toTab = async (action, payload) => {
                    const msg = Object.assign({ action, binding: { taskId, fileKey: t.fileKey, rowNum: t.rowNum } }, payload || {});
                    const send = () => chrome.tabs.sendMessage(tabId, msg);
                    // 与「一键换色」同一策略：豆包页尚未就绪（Receiving end does not exist）不算任务失败，
                    // 等页面挂上内容脚本后再发；只有页面明确返回错误才抛给用户。
                    for (let attempt = 0; attempt < 30; attempt++) {
                        const live = await SuiteTaskStore.get(taskId);
                        if (!live || live.cancelled || SuiteTaskStore.isTerminal(live.stage)) throw new Error('套图任务已取消或结束');
                        try {
                            return await send();
                        } catch (e) {
                            const m = String((e && e.message) || '');
                            if (!/Receiving end does not exist|Could not establish connection|No tab with id/i.test(m)) throw e;
                            // 第 3 次：扩展重载后旧标签没有内容脚本 → 主动注入
                            if (attempt === 3) {
                                try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/common.js', 'suite/suite-doubao.js'] }); } catch (_) {}
                            }
                            // 第 8 次：刷新该标签，让 manifest 重新注入
                            if (attempt === 8) {
                                try { await chrome.tabs.reload(tabId); } catch (_) {}
                            }
                            // 第 14 次：这个标签确实坏了 → 新开一个豆包页（不关闭用户原标签）
                            if (attempt === 14) {
                                try {
                                    const fresh = await chrome.tabs.create({ url: DOUBAO_URL, active: true });
                                    tabId = fresh.id;
                                    globalThis.__suiteExecLock.tabId = tabId;
                                } catch (_) {}
                            }
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                    throw new Error('豆包页面在 30 秒内未就绪：请打开一个能正常输入的豆包标签页后重试');
                };

                // ① 探测就绪 / 登录
                let pr = await toTab('suite-probe');
                for (let attempt=0; pr?.success && !pr.hasInput && !pr.loggedOut && attempt<60; attempt++) {
                    await new Promise(resolve=>setTimeout(resolve,250));
                    pr = await toTab('suite-probe');
                }
                if (!pr || !pr.success) throw new Error('豆包页面未就绪：' + ((pr && pr.error) || '无响应'));
                if (pr.loggedOut) throw new Error('豆包登录失效，请先登录后再发起套图');
                if (!pr.hasInput) throw new Error('豆包输入框未出现，页面结构可能已变化');

                // ② 基线（发送前已有图片）
                const bl = await toTab('suite-baseline', { binding: { taskId, fileKey: t.fileKey, rowNum: t.rowNum } });
                if (!bl || !bl.success) throw new Error('记录图片基线失败');
                const settings = await toTab('suite-settings', { settings: t.configSnapshot || {} });
                if (!settings || !settings.success) throw new Error('模型/比例校验失败：' + ((settings && settings.error) || '无响应'));
                // sent 只在实际发送取得证据之后写入。

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
                await SuiteTaskStore.advance(taskId, 'sent', { baselineUrls:sd.baselineUrls||bl.baselineUrls,doubaoUrl:(await chrome.tabs.get(tabId)).url,diag: [`已发送，基线 ${(sd.baselineUrls || []).length} 张，证据 ${sd.evidence || '-'}`] });

                // ⑥ 等待并采集本次新结果
                let wt;
                const deadline=Date.now()+600000;
                while(Date.now()<deadline){
                    wt=await toTab('suite-poll',{baselineUrls:sd.baselineUrls||bl.baselineUrls,expectCount:t.expectCount||5});
                    // 豆包额度耗尽（内容脚本每轮顺手判定）：立刻失败，不让整批空等 10 分钟
                    const quotaHit=(wt&&wt.result&&wt.result.quota&&wt.result.quota.exhausted)?wt.result.quota
                        :((wt&&wt.quota&&wt.quota.exhausted)?wt.quota
                        :((wt&&wt.success===false&&/额度已用完/.test(String(wt.error||'')))?{exhausted:true,text:String(wt.error||''),resumeAt:null}:null));
                    if(quotaHit){
                        // 页面侧统一口径：任务 error 文本含「额度已用完」即视为额度耗尽、暂停整批
                        const quotaError='QUOTA_EXHAUSTED：额度已用完'+(quotaHit.resumeAt?`（预计 ${quotaHit.resumeAt} 恢复）`:'');
                        await SuiteTaskStore.fail(taskId,quotaError,{quota:quotaHit}).catch(()=>{});
                        reply({ok:false,error:quotaError,quota:quotaHit});
                        return;
                    }
                    if(!wt?.success||wt.result?.ready)break;
                    await new Promise(resolve=>setTimeout(resolve,2000));
                }

                if (!wt || !wt.success) throw new Error('等待结果失败：' + ((wt && wt.error) || '未知'));
                const liveAfterWait = await SuiteTaskStore.get(taskId);
                if (!liveAfterWait || liveAfterWait.cancelled || SuiteTaskStore.isTerminal(liveAfterWait.stage)) throw new Error('任务已取消，丢弃迟到结果');
                const r = wt.result || {};
                if (!r.images || r.images.length < (t.expectCount || 5)) {
                    await SuiteTaskStore.fail(taskId, `结果不足：期望 ${t.expectCount || 5} 张，实际 ${(r.images || []).length} 张（原始 ${r.rawCount || 0}，同图归并 ${r.mergedGroups || 0} 组）`);
                    reply({ ok: false, error: `结果不足：${(r.images || []).length}/${t.expectCount || 5}` });
                    return;
                }
                await SuiteTaskStore.advance(taskId, 'acquired', { images: r.images, diag: [`获取 ${r.images.length} 张（原始 ${r.rawCount}，归并 ${r.mergedGroups} 组，基线 ${r.baselineCount}）`] }).catch(() => {});
                reply({ ok: true, taskId, stage: 'acquired', images: r.images, baselineUrls: sd.baselineUrls || bl.baselineUrls });
            } catch (e) {
                await SuiteTaskStore.fail(taskId, '执行阶段：' + (e && e.message)).catch(() => {});
                reply({ ok: false, error: e && e.message });
            } finally {
                const owned = globalThis.__suiteExecLock;
                if (owned && owned.taskId === taskId) {
                    if (owned.nativeAttached && owned.tabId) await chrome.debugger.detach({ tabId: owned.tabId }).catch(() => {});
                    globalThis.__suiteExecLock = null;
                }
            }
        })();
        return true;
    }
    // 路径配置保存的扩展转发：file:// 页面 Origin 是 null，服务端无法鉴别；
    // 由扩展（Origin 为 chrome-extension://自身ID）代发，服务端只放行扩展来源。
    if (request.action === 'savePathConfig') {
        (async () => {
            try {
                const r = await fetch('http://127.0.0.1:8765/path-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(request.config || {})
                });
                const data = await r.json();
                sendResponse(data || { ok: false, error: '保存失败' });
            } catch (e) {
                sendResponse({ ok: false, error: (e && e.message) || '本地服务未启动' });
            }
        })();
        return true;
    }

    // AI 标题精简（后处理脚本调用）：走后台 fetch，避免页面 file:// 源的跨域限制
    if (request.action === 'aiSimplifyTitle') {
        (async () => {
            try {
                const stored=await chrome.storage.local.get('polo_deepseek_config');
                const cfg = stored.polo_deepseek_config ? {deepseek:stored.polo_deepseek_config} : await (await fetch(chrome.runtime.getURL('js代码/api_config.json'),{signal:AbortSignal.timeout(10000)})).json();
                const ds = { ...((cfg && cfg.deepseek) || {}), ...Object.fromEntries(Object.entries(request.apiConfig||{}).filter(([key,value])=>['url','model','apiKey'].includes(key)&&typeof value==='string'&&value.trim())) };
                if (!ds.apiKey) { sendResponse({ ok: false, error: '未配置 DeepSeek API Key' }); return; }
                const maxChars = Number(request.maxChars || ds.maxChars || 60);
                const prompt = String(ds.prompt || '把英文电商标题压缩到不超过 {maxChars} 个字符，保留核心卖点与材质规格，只输出标题本身。').replace(/\{maxChars\}/g, String(maxChars));
                const r = await fetch(ds.url, {
                    signal: AbortSignal.timeout(30000),
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ds.apiKey },
                    body: JSON.stringify({
                        model: ds.model || 'deepseek-chat',
                        temperature: 0.3,
                        max_tokens: 120,
                        messages: [
                            { role: 'system', content: prompt },
                            { role: 'user', content: String(request.title || '') }
                        ]
                    })
                });
                if (!r.ok) { sendResponse({ ok: false, error: 'HTTP ' + r.status }); return; }
                const data = await r.json();
                const text = String((((data.choices || [])[0] || {}).message || {}).content || '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
                if (!text) { sendResponse({ ok: false, error: '模型未返回标题' }); return; }
                sendResponse({ ok: true, title: text });
            } catch (e) { sendResponse({ ok: false, error: (e && e.message) || 'AI 精简失败' }); }
        })();
        return true;
    }

    // 打开扩展弹窗（用于重新选择/授权颜色图目录：FSA 授权必须有用户手势，页面无法直接请求）
    if (request.action === 'openExtensionPopup') {
        try {
            chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }, () => {
                if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
                sendResponse({ ok: true });
            });
        } catch (e) { sendResponse({ ok: false, error: e.message }); }
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
                // 未确认的保存不算"已保存"：重发同一文件时允许重填核对（草稿重复保存 ≠ 重复发布）
                const savedRow = saved[rowNum];
                const savedVerified = !!(savedRow && !isUnverifiedSave(savedRow));
                const autoFillAllowed = !savedVerified && !alreadyFilled
                    && Number(t.currentRow) === Number(rowNum) && !!sender.tab && sender.tab.id === t.currentTabId;
                if (t.products && Object.prototype.hasOwnProperty.call(t.products, String(rowNum))) {
                    const data = t.products[String(rowNum)];
                    // filled 告诉页3：队列里这一行是否已记完成，避免重复补发 publishFilled 把队列推进到下一行
                    sendResponse({ ok: !!data, autoFillAllowed, filled: alreadyFilled, data: data ? { ...data, _publishTaskId: t.taskId, _publishFileKey: taskFileKey(t), _publishImageDir: t.imageDir } : null });
                } else if (!t.products) {
                    // 兼容已存在的旧任务；未完成任务期间存储写入已被拒绝。
                    finish(taskFileKey(t), { autoFillAllowed, filled: alreadyFilled });
                } else sendResponse({ ok: false, error: '该行不属于任务产品快照' });
            });
        } else {
            finish(getFilePrefix(), { filled: false });
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
                skippedRows: [],
                batchSize: s.batchSize,
                batchFilled: 0,
                batchFilledDone: 0,
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
                return { ok: true, count: rows.length, taskId: task.taskId, batchSize: task.batchSize };
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
        if (globalThis.__suiteExecLock) { sendResponse({ ok: false, error: '套图正在执行，请稍后换色' }); return true; }
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
        const fileKey = typeof request.fileKey === 'string' ? request.fileKey : getFilePrefix();
        const storageKey = fileKey + 'color__' + request.rowNum;
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
                    sendResponse({ ok: true, images: Object.keys(images), fileKey });
                });
            } else {
                sendResponse({ ok: true, images: Object.keys(images), fileKey });
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
                sendResponse({ ok: true, reloadTs: r['polo_ext_reload_ts'] || 0, publicationImagesVersion: 1 });
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
            assistantBridgeReady = false;   // 新端口必须重新握手，防止请求发到未就绪页面
            console.log('✅ [onConnectExternal] 发品助手长连接已建立, tabId=', assistantTabId);
            // 连接建立后主动推一次任务状态：页面刷新/重连后能立刻恢复面板与暂停原因
            broadcastPublishState().catch(() => {});
            port.onDisconnect.addListener(() => {
                console.log('🔌 [onConnectExternal] 发品助手长连接已断开');
                if(assistantPort!==port)return;
                assistantPort = null;
                assistantBridgeReady = false;
                for(const pending of pageDirectoryRequests.values()){clearTimeout(pending.timer);clearTimeout(pending.ackTimer);pending.reject(Error('看板页面已断开，目录操作停止'));}
                pageDirectoryRequests.clear();
                for(const pending of publicationRequests.values()){clearTimeout(pending.timer);pending.reject(Error('发品助手连接断开，图片上传已停止'));}
                publicationRequests.clear();
            });
            port.onMessage.addListener((msg) => {
                handleBridgePortMessage(port, msg);
                if(msg.action==='publicationImagesResponse'&&assistantPort===port){
                    const pending=publicationRequests.get(msg.requestId);
                    if(pending){clearTimeout(pending.timer);publicationRequests.delete(msg.requestId);msg.ok?pending.resolve(msg.files):pending.reject(Error(msg.error||'生成图片读取失败'));}
                }
                console.log('🔍 [onConnectExternal] 收到消息:', msg.action);
            });
            // 监听注册完成后再主动探测一次目录桥：页面连接时抢先发出的首条消息可能被丢弃，
            // 由扩展侧发起可确保页面一定能收到并回 bridgeReady。
            try{port.postMessage({action:'bridgeProbe'});}catch(_){}
        }
    }).catch((err) => {
        console.warn('[onConnectExternal] 来源校验异常，断开连接:', err.message);
        port.disconnect();
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // The native bridge owns this response; do not race it with the unknown-action fallback.
    if (request.action === 'doubao-native-input') return;
    console.log(`🔍 [onMessage] 收到消息: action=${request.action}, sender=${sender?.tab?.url ? 'tab' : 'unknown'}`);
    if (request.action === 'savePublishProduct' || request.action === 'recordPublishSaveClick') {
        savePublishProduct(request, sender, request.action === 'savePublishProduct').then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // ---------- 豆包生成结果记账（内部通道：换色内容脚本上报出图/失败） ----------
    if (request.action === 'doubaoGenResult') {
        const tabId = sender && sender.tab ? sender.tab.id : 0;
        doubaoGenResultSerialized(request, tabId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // ---------- 发品任务（内部通道：content script 发来，sender.tab 可信） ----------
    if (request.action === 'publishFilled') {
        const tabId = sender && sender.tab ? sender.tab.id : undefined;
        const frameId = sender ? sender.frameId : undefined;
        // 记下上报来源与原因，事后能回答「这行为什么没保存」
        if (request.note || request.skipped) {
            appendPublishLog({ level: 'page3', tabId, row: request.row, msg: 'publishFilled ' + (request.note || (request.skipped ? 'skip' : '')) });
        }
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
        pausePublishTaskManual().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, message: e.message }));
        return true;
    }
    if (request.action === 'resumePublishQueue') {
        resumePublishTask().then(sendResponse).catch(e => sendResponse({ ok: false, message: e.message }));
        return true;
    }
    if (request.action === 'discardPublishTask') {
        discardPublishTask().then(sendResponse).catch(e => sendResponse({ ok: false, message: e.message }));
        return true;
    }
    if (request.action === 'getPublishState') {
        buildPublishStatePayload().then(sendResponse);
        return true;
    }
    if (request.action === 'setPublishSettings') {
        setPublishSettings(request.patch || {})
            .then(s => sendResponse({ ok: true, settings: s }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
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
        if ((request.data?.byteLength || request.data?.length || 0) > 100 * 1024 * 1024) {
            console.warn('⛔ [PS编辑] psEditSave 数据过大拒绝:', request.data?.byteLength);
            sendResponse({ ok: false, error: '数据过大' });
            return true;
        }
        console.log('[PS编辑] background 收到 psEditSave 消息');
        handlePsEditSave(request.data).then(sendResponse).catch(e=>sendResponse({ok:false,error:e.message}));
        return true;
    }

    if (request.action === 'psEditSaveFsa') {
        // L1：来源与大小校验（同 psEditSave）
        if (sender.tab?.id !== psEditState?.tabId) {
            console.warn('⛔ [PS编辑] 拒绝非 Photopea 来源的 psEditSaveFsa');
            sendResponse({ ok: false, error: '来源不符' });
            return true;
        }
        if ((request.data?.byteLength || request.data?.length || 0) > 100 * 1024 * 1024) {
            console.warn('⛔ [PS编辑] psEditSaveFsa 数据过大拒绝:', request.data?.byteLength);
            sendResponse({ ok: false, error: '数据过大' });
            return true;
        }
        console.log('[PS编辑] background 收到 psEditSaveFsa 消息，fileName:', request.fileName, 'data length:', request.data?.byteLength);
        handlePsEditSaveFsa(request.data, request.fileName).then(sendResponse).catch(e=>sendResponse({ok:false,error:e.message}));
        return true;
    }

    console.log(`🔍 [onMessage] 调用handleSharedAction: action=${request.action}`);
    const sharedActions = ['listScriptDirectory','readScriptDirectory','psDirectoryStatus', 'readPsImage', 'writePsImage', 'saveProductData', 'saveBatchProducts', 'getProductByRow', 'openPublishPage', 'openBatchPublish', 'publishCompleted', 'markUploaded', 'getUploadedRows', 'startColorChange', 'startAiEdit', 'startPsEdit', 'getColorImage', 'getColorImagesInfo', 'getColorImagePath', 'setCurrentFilename', 'getPsEditResult', 'clearPsEditResult', 'getConfig', 'colorTaskAccepted', 'getColorExecStatus', 'clearColorExec', 'getColorTaskEvents', 'pauseColorDispatch', 'getMemoryGate', 'pausePublishQueue', 'resumePublishQueue', 'getPublishState', 'setPublishSettings', 'getDiagLog', 'clearDiagLog', 'retryPublishRow', 'skipPublishRow', 'suiteCreate', 'suiteGetTask', 'suiteListTasks', 'suiteCancel', 'suiteProgress', 'suiteRecover', 'suiteRecoverResults', 'suiteRun', 'openExtensionPopup', 'aiSimplifyTitle', 'savePathConfig', 'reloadExtension', 'updaterFetch'];
    if (sharedActions.includes(request.action)) {
        handleSharedAction(request, sendResponse, sender).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if(request.action==='publishImageProgress'){
        if(sender.tab?.id&&publicationUploadLocks.has(sender.tab.id))notifyAssistant('publishImageProgress',{phase:request.phase,done:request.done,total:request.total,fileKey:getFilePrefix(),rowNum:request.rowNum});
        sendResponse({ok:true});return true;
    }
    if(request.action==='uploadPublicationImages'){
        const tabId=sender.tab?.id;
        if(!tabId){sendResponse({ok:false,error:'缺少上传目标页面'});return false;}
        let uploadPage;try{uploadPage=new URL(sender.tab?.url||sender.url||'');}catch(_){}
        const page2=uploadPage?.pathname==='/product/easyListing.htm';
        const allowed=uploadPage?.protocol==='https:'&&uploadPage.hostname==='post.alibaba.com'&&(uploadPage.pathname.startsWith('/product/publish')||(page2&&request.kind==='main'));
        if(!allowed){
            sendResponse({ok:false,error:'只能在阿里商品发布编辑页上传图片'});return false;
        }
        if(publicationUploadLocks.has(tabId)){sendResponse({ok:false,error:'该页面正在上传图片，请等待完成'});return false;}
        publicationUploadLocks.add(tabId);
        (async()=>{try{
            const prepared=await PublicationImages.prepare(request.product,request.kind,readPublicationGenerated,async path=>{
                const response=await fetch(chrome.runtime.getURL(path));if(!response.ok)throw Error('类目公共图读取失败：'+path);return response.blob();
            });
            const frames=await chrome.webNavigation.getAllFrames({tabId});let chosen=null,enable=null;
            for(const frame of frames||[{frameId:0}]){
                if(frame.frameId!==0){try{if(!/(^|\.)alibaba\.com$/.test(new URL(frame.url).hostname))continue;}catch(_){continue;}}
                try{
                    await chrome.scripting.executeScript({target:{tabId,frameIds:[frame.frameId]},files:['upload/publication-dom.js']});
                    const result=await chrome.scripting.executeScript({target:{tabId,frameIds:[frame.frameId]},func:kind=>globalThis.PublicationDom.probe(kind),args:[request.kind]});
                    if(result[0]?.result?.found){chosen=frame.frameId;break;}
                    if(result[0]?.result?.canEnable)enable=frame.frameId;
                }catch(e){if(frame.frameId===0)throw e;}
            }
            if(chosen===null)chosen=enable;
            if(chosen===null)throw Error('未找到'+(request.kind==='main'?'主图':'细节图')+'上传区域，请先选择对应模板');
            const executed=await chrome.scripting.executeScript({target:{tabId,frameIds:[chosen]},func:async(kind,files)=>{
                try{return await globalThis.PublicationDom.perform(kind,files);}catch(e){return {ok:false,error:e.message};}
            },args:[request.kind,prepared.files]});
            const result=executed[0]?.result;if(!result?.ok)throw Error(result?.error||'页面没有确认上传成功');
            sendResponse({...result,category:prepared.category});
        }catch(e){sendResponse({ok:false,error:e.message});}finally{publicationUploadLocks.delete(tabId);}})();return true;
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
        if (globalThis.__suiteExecLock) { sendResponse({ ok: false, error: '套图正在执行，请稍后换色' }); return true; }
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
                // 额度耗尽判定（豆包内容脚本回传）：只在命中时附加，未命中时载荷结构与原来完全一致
                const quota = (request.quota && request.quota.exhausted === true) ? {
                    exhausted: true,
                    text: String(request.quota.text || '').slice(0, 200),
                    resumeAt: request.quota.resumeAt ? String(request.quota.resumeAt).slice(0, 40) : null
                } : null;
                // 同一份不可变终态载荷：存储事件与所有通知通道共用，贯穿结果与执行/文件身份
                const payload = Object.freeze({
                    rowNum,
                    batchId,
                    fileKey: exec.fileKey || '',
                    fileFolder: exec.fileFolder || DEFAULT_FILE_FOLDER,
                    execStartedAt: exec.startedAt || 0,
                    executionId: exec.executionId || null,
                    results: request.results || null,
                    ...(quota ? { quota } : {}),
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

    // 自更新：由后台代取网络资源（页面 file:// 直连 GitHub 常被 CORS/网络拦）
    if (request.action === 'updaterFetch') {
        (async () => {
            const url = String(request.url || '');
            if (!/^https:\/\/(api\.github\.com|cdn\.jsdelivr\.net|raw\.githubusercontent\.com)\//.test(url)) {
                return sendResponse({ ok: false, error: '不允许的地址' });
            }
            let lastErr = '';
            for (let i = 0; i < 3; i++) {
                try {
                    const r = await fetch(url, { cache: 'no-store', headers: { Accept: request.json ? 'application/json' : '*/*' } });
                    if (!r.ok) { lastErr = 'HTTP ' + r.status; if (r.status === 404) break; }
                    else if (request.json) sendResponse({ ok: true, status: r.status, text: await r.text() });
                    else {
                        const buf = new Uint8Array(await r.arrayBuffer());
                        let bin = '';
                        for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
                        sendResponse({ ok: true, status: r.status, base64: btoa(bin) });
                    }
                    return;
                } catch (e) { lastErr = String((e && e.message) || e); }
                await new Promise(r2 => setTimeout(r2, 700));
            }
            sendResponse({ ok: false, error: lastErr || '请求失败' });
        })();
        return true;
    }

    // 自更新完成后重载扩展自身（等于在 chrome://extensions 点刷新）
    if (request.action === 'reloadExtension') {
        sendResponse({ ok: true });
        setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 500);
        return true;
    }

    // 清除指定行的"已保存"记录：这些行草稿是空的/缺项，需要重新填一遍。
    // 没有这个入口时，被误记成已保存的行会永远被跳过（真机 62/71/74/78）。
    if (request.action === 'clearPublishSavedRows') {
        (async () => {
            const rows = String(request.rows || '').split(/[\s,，、]+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
            if (!rows.length) return sendResponse({ ok: false, error: '请填写行号' });
            const fileKey = request.fileKey || getFilePrefix();
            const stored = await new Promise(r => chrome.storage.local.get(PUBLISH_VERIFIED_SAVED_KEY, r));
            const all = stored[PUBLISH_VERIFIED_SAVED_KEY] || {};
            const bucket = all[fileKey] || {};
            const removed = [];
            for (const row of rows) {
                if (Object.prototype.hasOwnProperty.call(bucket, String(row))) { delete bucket[String(row)]; removed.push(row); }
            }
            all[fileKey] = bucket;
            await new Promise(r => chrome.storage.local.set({ [PUBLISH_VERIFIED_SAVED_KEY]: all }, r));
            await appendPublishLog({ level: 'clearSaved', rows: removed, fileKey });
            await broadcastPublishState();
            sendResponse({ ok: true, removed, fileKey });
        })().catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    // 页面关键日志落后台：页面被刷新/关闭后仍能查到这一行为什么失败
    if (request.action === 'page3Log') {
        const tabId = sender && sender.tab ? sender.tab.id : 0;
        let row = 0;
        try {
            const u = new URL((sender && sender.tab && sender.tab.url) || '');
            row = Number(u.searchParams.get('row')) || 0;
        } catch (_) {}
        appendPublishLog({ level: 'page3', tabId, row, msg: String(request.msg || '').slice(0, 160), pageLevel: request.level || 'info' });
        sendResponse({ ok: true });
        return true;
    }

    // 箱规 iframe 的日志回传到主页面面板（以前 only console，卡住时看不到停在哪一步）
    if (request.action === 'boxRuleLog') {
        const tabId = sender && sender.tab ? sender.tab.id : 0;
        if (tabId && request.msg) {
            chrome.tabs.sendMessage(tabId, { action: 'log', msg: '📦 [箱规] ' + String(request.msg) }).catch(() => {});
        }
        sendResponse({ ok: true });
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

let suitePagePreparing = null;
function prepareSuiteDoubaoPage() {
    if (suitePagePreparing) return suitePagePreparing;
    suitePagePreparing = (async () => {
        const tab = await findDoubaoTab() || await chrome.tabs.create({url:DOUBAO_URL,active:true});
        await chrome.tabs.update(tab.id,{active:true});
        if (tab.windowId) await chrome.windows.update(tab.windowId,{focused:true});
        return tab;
    })().finally(() => { suitePagePreparing = null; });
    return suitePagePreparing;
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
        // 失效身份自愈：页面刷新/回收后遗留的执行身份会一直挡住后续换色
        let live = false;
        try {
            if (prevExec.tabId) {
                await chrome.tabs.get(prevExec.tabId);
                const st = await chrome.tabs.sendMessage(prevExec.tabId, { action: 'getColorTaskStatus' }).catch(() => null);
                const sameTask = !!(st && st.ok === true && st.isProcessing === true && st.task
                    && prevExec.executionId && st.task.executionId === prevExec.executionId);
                live = sameTask;
                if (st && st.ok === true && st.isProcessing === true && !sameTask) {
                    // 页面里跑的不是这份执行身份：取消它，释放豆包输入通道
                    await chrome.tabs.sendMessage(prevExec.tabId, { action: 'cancelColorTask' }).catch(() => {});
                }
            }
        } catch (_) { live = false; }
        if (!live && prevExec.state === 'pending' && Date.now() - (prevExec.startedAt || 0) < 120000) {
            return { ok: false, busy: true, error: '已有执行或待接收任务，未覆盖原执行身份' };
        }
        if (live) return { ok: false, busy: true, error: '豆包仍在生成上一款，请等它完成后再换色' };
        console.warn('🧹 清理失效的换色执行身份（执行页已结束或已关闭）');
        await saveActiveColorExec(null);
        await savePendingColorTask(null);
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

        const fileName=decodeURIComponent(String(imagePath||'').split(/[\\/]/).pop().split('?')[0]);
        const source=await pageDirectoryRequest({action:'readPsImage',fileName});
        if(!source.ok||!source.dataUrl)throw Error(source.error||'页面产品原图读取失败');
        // 磁盘上 png/jpg 混存：页面读图会按实际命中的后缀回报文件名，上传用真实名，避免类型与后缀对不上。
        const actualName=source.filename||fileName;
        const injected=await chrome.scripting.executeScript({target:{tabId:targetId},func:async(dataUrl,name)=>{
            const input=document.querySelector('input[type="file"]');
            if(!input)throw Error('未找到豆包文件输入框');
            const blob=await(await fetch(dataUrl)).blob();
            const transfer=new DataTransfer();transfer.items.add(new File([blob],name,{type:blob.type}));
            input.files=transfer.files;
            input.dispatchEvent(new Event('input',{bubbles:true}));
            input.dispatchEvent(new Event('change',{bubbles:true}));return true;
        },args:[source.dataUrl,actualName]});
        if(!injected[0]?.result)throw Error('豆包图片上传未成功');
        return {ok:true};

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

            // 页面为唯一目录来源：直接写入页面选择的实际文件夹，不再下载到另一位置。
            if(!dataUrl)return resolve({ok:false,error:'无法获取颜色图，未写入页面目录'});
            try{
                const saved=await pageDirectoryRequest({action:'pageWriteColor',dataUrl,filename,rowNum,fileFolder});
                if(colorMatch){
                    const storageKey=bound.fileKey+'color__'+rowNum;
                    const old=await chrome.storage.local.get(storageKey);
                    await chrome.storage.local.set({[storageKey]:{...(old[storageKey]||{}),[colorMatch[1]]:{url,path:saved.path}}});
                }
                return resolve({ok:true,filename,path:saved.path});
            }catch(e){return resolve({ok:false,error:e.message});}
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
        timestamp: payload.timestamp,
        // 额度耗尽只在命中时附带，未命中不改变通知结构（页面旧逻辑零影响）
        ...(payload.quota ? { quota: payload.quota } : {})
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

async function fetchColorImageAsBase64(rowNum, color, expectedFileKey, fileFolder) {
    if(expectedFileKey!==undefined&&expectedFileKey!==getFilePrefix())return {ok:false,error:'颜色图所属文件已切换'};
    try{
        const result=await pageDirectoryRequest({action:'pageReadColor',rowNum,color,fileFolder:fileFolder||CURRENT_FILENAME||DEFAULT_FILE_FOLDER});
        if(expectedFileKey!==undefined&&expectedFileKey!==getFilePrefix())return {ok:false,error:'颜色图所属文件已切换'};
        return result;
    }catch(e){return {ok:false,error:e.message};}
    /* 旧目录读取实现保留用于迁移核对，不再执行。 */
    const fileKey = getFilePrefix(), fileName = CURRENT_FILENAME;
    if (expectedFileKey !== undefined && expectedFileKey !== fileKey) return {ok:false,error:'颜色图所属文件已切换'};
    let directoryError = null;
    if(COLOR_IMG_DIR && !PoloDirectories.isColorSelection(COLOR_IMG_DIR)) {
        const context={fileKey,fileFolder:fileName||DEFAULT_FILE_FOLDER,colorImgDir:COLOR_IMG_DIR};
        const diskPath=buildColorImagePath(rowNum,color,context);
        try{
            const response=await fetch('http://127.0.0.1:8765/local-image',{
                method:'POST',
                cache:'no-store',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({root:COLOR_IMG_DIR,path:diskPath})
            });
            if(!response.ok)throw Error('本地颜色图读取失败：'+response.status);
            const blob=await response.blob();
            if(!blob.size||!isRasterImageType(blob.type))throw Error('本地颜色图文件无效');
            const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
            for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
            if(expectedFileKey!==undefined&&expectedFileKey!==getFilePrefix())return {ok:false,error:'颜色图所属文件已切换'};
            return {ok:true,fromDisk:true,dataUrl:'data:'+blob.type+';base64,'+btoa(binary)};
        }catch(error){return {ok:false,fromDisk:false,error:'本地颜色图无法读取：'+error.message};}
    }
    if (typeof PoloDirectories !== 'undefined' && PoloDirectories.isColorSelection(COLOR_IMG_DIR)) {
        try { return {ok:true,fromDisk:true,dataUrl:await PoloDirectories.colorImage(COLOR_IMG_DIR,fileName||DEFAULT_FILE_FOLDER,rowNum,color)}; }
        catch(error) {
            // 磁盘是唯一真相：文件明确缺失/读取失败 → 如实返回缺失，不回落缓存冒充存在。
            // 仅「权限待确认」这类无法判定磁盘状态的错误，才允许用已有缓存临时展示。
            const msg = String((error && error.message) || error || '');
            const permUncertain = /permission|authoriz|denied|notallowed|securityerror|授权|待确认|用户拒绝/i.test(msg);
            if (!permUncertain) {
                console.log(`⛔ 颜色图磁盘缺失（${COLOR_IMG_DIR}/${fileName||DEFAULT_FILE_FOLDER}/row${rowNum}/${color}）：${msg}`);
                return { ok: false, error: msg || '颜色图文件缺失' };
            }
            directoryError = error;
        }
    }

    if (expectedFileKey !== undefined && expectedFileKey !== fileKey) return { ok: false, error: '颜色图所属文件已切换' };
    try {
        const idbKey = colorImageIDBKey(fileName, rowNum, color);
        const cached = await getColorImageFromIDB(idbKey);
        if (cached) {
            console.log(`✅ 颜色图从 IndexedDB 命中: ${idbKey}`);
            // fromDisk:false —— 这只是历史缓存，不能作为「磁盘文件仍存在」的证据
            return { ok: true, fromDisk: false, dataUrl: cached };
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
        if (!url) return { ok: false, error: directoryError?.message || '图片URL不存在' };

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
                resolve({ ok: true, fromDisk: false, dataUrl });
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
        saveViaAssistant: task.saveViaAssistant === true,
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
                        
                        window.postMessage({type:'PS_EDIT_SAVE_FSA',data:Array.from(uint8),format,fileName:targetFileName},location.origin);
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
                data: event.data.data instanceof ArrayBuffer ? Array.from(new Uint8Array(event.data.data)) : event.data.data
            });
        }
        if (event.data && event.data.type === 'PS_EDIT_SAVE_FSA') {
            console.log('[PS拦截] 收到 PS_EDIT_SAVE_FSA 消息，format:', event.data.format, 'rowNum:', event.data.rowNum, 'fileName:', event.data.fileName);
            chrome.runtime.sendMessage(EXT_ID, {
                action: 'psEditSaveFsa',
                data: event.data.data instanceof ArrayBuffer ? Array.from(new Uint8Array(event.data.data)) : event.data.data,
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
    const parsed = parsePsSaveData(arrayBuffer);
    if (!parsed) throw new Error('解析PS保存数据失败');
    return handlePsEditSaveFsa(Array.from(parsed.imgData));
}

// 扩展自身 ID：动态获取，避免换电脑/重新加载扩展时 ID 变化导致失效
const EXTENSION_ID = chrome.runtime.id;

const PS_EDIT_RESULT_KEY = 'ps_edit_result';

async function handlePsEditSaveFsa(data, fileName) {
    const state = psEditState;
    if (!state || state.saved || state.saving) return {ok:false,error:'任务已保存或正在保存'};
    state.saving = true;
    try {
        const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), c=>c.charCodeAt(0)) : new Uint8Array(data);
        if (!bytes.length || bytes.length > 100*1024*1024) throw new Error('图片为空或过大');
        const format = bytes[0]===0xff && bytes[1]===0xd8 ? 'jpg' : 'png';
        const directory = await PoloDirectories.status();
        let savedByExtension = false;
        if (directory.configured && directory.permission === 'granted' && !state.saveViaAssistant) {
            await PoloDirectories.write(state.fileName, Array.from(bytes), format);
            savedByExtension = true;
        }
        const result = {rowNum:state.rowNum,fileName:state.fileName,imgData:Array.from(bytes),format,savedByExtension,timestamp:Date.now()};
        await chrome.storage.local.set({[PS_EDIT_RESULT_KEY]:result});
        state.saved = true; // captured export; disk success is separately explicit in savedByExtension
        chrome.runtime.sendMessage(EXTENSION_ID,{action:'psEditComplete',...result}).catch(()=>{});
        return {ok:true,saved:savedByExtension,pendingLegacySave:!savedByExtension};
    } finally {state.saving=false;}
}
