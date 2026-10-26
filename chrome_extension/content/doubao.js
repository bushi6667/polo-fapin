// ============================================================
// doubao.js —— 豆包 AI 换色/改图自动化执行器（注入 doubao.com 页面）
// 职责：在豆包网页上模拟真人操作完成「AI 换色」流程：
//   切换图像生成模式 → 上传图片 → 输入提示词 → 发送 → 轮询下载
//   4 张新图（white/black/gray/navy，无水印原图优先，见 doubao_raw.js）
// 通信：监听 background 的 startColorTask / startAiEditTask / getColorTaskStatus
// 注意：依赖豆包页面 DOM 结构（类名随站点改版可能变化）
// ============================================================
let colorTask = null;
let isProcessing = false;
let heartbeatTimer = null;

// 统一日志前缀
function log(msg, type = 'info') {
    console.log('[豆包AI换色]', msg);
}

// 心跳保活：防止 MV3 Service Worker 休眠导致 assistantPort 丢失
// 批量换色任务期间每 20 秒发一次心跳，任务结束后停止
function startHeartbeatForColorTask() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        try {
            chrome.runtime.sendMessage({ action: 'heartbeat' }, () => {
                if (chrome.runtime.lastError) {
                    console.log('[豆包AI换色][心跳] SW未响应:', chrome.runtime.lastError.message);
                }
            });
        } catch (e) {}
    }, 20000);
    console.log('[豆包AI换色][心跳] 已启动（20s间隔）');
}

// 停止心跳
function stopHeartbeatForColorTask() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log('[豆包AI换色][心跳] 已停止');
    }
}

// 延时工具
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 原生 value setter 设值 + input/change 事件（绕过 React 受控组件）
function setInputValue(el, val) {
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const setter = proto?.value?.set;
    if (setter) {
        setter.call(el, val);
    } else {
        el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

// 模拟真实鼠标点击（坐标中心 + mousedown/mouseup/click），失败降级 el.click()
function nativeMouseClick(el) {
    if (!el) return false;
    try {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        el.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0
        }));
        el.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0
        }));
        el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0
        }));
        return true;
    } catch (e) {
        try { el.click(); return true; } catch (_) { return false; }
    }
}

// 定位「图像生成」模式按钮（优先 data-skill-id，其次按文本模糊匹配）
function findImageGenButton() {
    const selectors = [
        'button[data-skill-id="skill_bar_button_3"]',
        'div[data-skill-id="skill_bar_button_3"]',
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetHeight > 0) return el;
    }
    const allBtns = document.querySelectorAll('button, div[role="button"]');
    for (const btn of allBtns) {
        const txt = (btn.innerText || '').trim();
        if ((txt.includes('图像生成') || txt.includes('图片生成')) && btn.offsetHeight > 0) {
            return btn;
        }
    }
    return null;
}

// 定位聊天输入框（textarea / contenteditable / role=textbox 多选择器）
function findChatInput() {
    const selectors = [
        'textarea',
        '[contenteditable="true"]',
        'div[role="textbox"]',
        '.chat-input textarea',
        '.input-box textarea',
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetHeight > 0) return el;
    }
    return null;
}

// 定位「新对话 / 新建对话」按钮：只认可见元素，先按文案精确匹配，再退到 aria-label
function findNewChatButton() {
    const labels = ['新对话', '新建对话'];
    const candidates = document.querySelectorAll('button, div[role="button"], a');
    let loose = null;
    for (const el of candidates) {
        if (!el || el.offsetHeight <= 0) continue;
        const txt = (el.innerText || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        if (labels.includes(txt) || labels.includes(aria)) return el;
        if (!loose && (labels.some(l => txt.includes(l)) || labels.some(l => aria.includes(l)))) loose = el;
    }
    return loose;
}

// 开一个新对话：让上一款（可能超时/失败）迟到的图不落进这一款的会话里
// 找不到按钮就放弃（不阻断任务，也不抛错）
async function startNewChat() {
    try {
        const btn = findNewChatButton();
        if (!btn) {
            log('未找到「新对话」按钮，沿用当前会话', 'warn');
            return false;
        }
        nativeMouseClick(btn);
        await sleep(1200 + Math.floor(Math.random() * 800));   // 等新会话输入框就绪
        log('已切换到新对话');
        return true;
    } catch (e) {
        log('切换新对话失败（忽略）: ' + e.message, 'warn');
        return false;
    }
}

// 定位「发送」按钮（按文本精确/包含匹配）
function findSendButton() {
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
        const txt = (btn.innerText || '').trim();
        if ((txt === '发送' || txt.includes('发送')) && btn.offsetHeight > 0) {
            return btn;
        }
    }
    return null;
}

// 定位可见的 file input（用于 CDP 注入图片文件）
function findFileInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const inp of inputs) {
        if (inp.offsetParent !== null || inp.style.display !== 'none') {
            return inp;
        }
    }
    return inputs[0] || null;
}

// 定位「上传图片」按钮（优先找含 file input 的按钮，其次用 file input 父元素）
function findUploadButton() {
    const allEls = document.querySelectorAll('button, div, span, label');
    for (const el of allEls) {
        const txt = (el.innerText || '').trim();
        if ((txt.includes('上传') || txt.includes('图片') || txt.includes('+')) && el.offsetHeight > 0) {
            const inp = el.querySelector('input[type="file"]');
            if (inp) return { btn: el, input: inp };
        }
    }
    const fileInp = findFileInput();
    if (fileInp) {
        return { btn: fileInp.parentElement, input: fileInp };
    }
    return null;
}

// 切换豆包到「图像生成」模式（点击图像生成按钮并等待渲染）
async function switchToImageGenMode() {
    log('切换到图像生成模式...');
    const btn = findImageGenButton();
    if (!btn) {
        log('未找到图像生成按钮', 'warn');
        return false;
    }
    nativeMouseClick(btn);
    await sleep(2000);
    log('已点击图像生成按钮');
    return true;
}

// 上传图片：发消息给 background，由其用 CDP 注入文件到豆包页面的 file input
async function uploadImage(imagePath) {
    if (!imagePath) throw new Error('主图路径为空，未向豆包发送生成请求');
    log('上传图片: ' + imagePath);
    const resp = await chrome.runtime.sendMessage({
        action: 'doubaoUploadImage',
        imagePath: imagePath
    });
    if (resp?.ok) {
        log('图片上传请求已发送');
        await sleep(2000);
        return true;
    }
    const error = resp?.error || '未知错误';
    log('图片上传失败: ' + error, 'error');
    throw new Error('主图上传失败：' + error);
}

// 在聊天输入框输入提示词（textarea 走原生 setter，contenteditable 直接 innerText）
async function typePrompt(prompt) {
    log('输入提示词...');
    const input = findChatInput();
    if (!input) {
        log('未找到输入框', 'error');
        return false;
    }

    input.focus();
    await sleep(200);

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        setInputValue(input, prompt);
    } else {
        input.innerText = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(500);
    log('提示词已输入');
    return true;
}

// 发送消息：点发送按钮；找不到则用 execCommand 回车发送
async function sendMessage() {
    log('发送消息...');
    const sendBtn = findSendButton();
    if (sendBtn) {
        nativeMouseClick(sendBtn);
    } else {
        const input = findChatInput();
        if (input) {
            input.focus();
            document.execCommand('SelectAll');
            document.execCommand('insertText', false, '\n');
        }
    }
    await sleep(1000);
    log('消息已发送');
    return true;
}

// 无水印原图 URL 映射（hash -> image_raw URL，由 doubao_raw.js 捕获后经事件同步）
const rawUrlMap = new Map();

// 监听 doubao_raw.js（MAIN world）广播的原图捕获事件
document.addEventListener('_poloRawUrlUpdate', (e) => {
    rawUrlMap.set(e.detail.hash, e.detail.url);
});

// 从图片 URL 提取 hash（用于映射原图）
function getHashFromUrl(url) {
    if (!url) return null;
    const m = url.match(/([a-f0-9]{20,40})/i);
    return m ? m[1] : null;
}

// 取无水印原图 URL（有映射用原图，否则回退传入 src）
function getRawUrl(imgSrc) {
    const hash = getHashFromUrl(imgSrc);
    if (!hash) return imgSrc;
    const raw = rawUrlMap.get(hash);
    return raw || imgSrc;
}

// 收集页面内豆包 AI 消息里的全部 byteimg/tos-alistore 图片 URL（去重、优先原图）
function getAllImageUrls() {
    const urls = [];
    const seen = new Set();

    // 判断元素是否属于豆包 AI 消息（向上 10 层找消息容器类名；justify-end 为用户消息）
    function isDoubaoMessage(el) {
        let parent = el.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
            const className = (parent.className || '').toString();
            if (className.includes('container-MzuYIN') || className.includes('container-dLabXv')) {
                return true;
            }
            if (className.includes('justify-end')) {
                return false;
            }
            parent = parent.parentElement;
        }
        return false;
    }

    document.querySelectorAll('img, source').forEach(el => {
        if (!isDoubaoMessage(el)) return;
        const src = el.getAttribute('src') || el.getAttribute('srcset') || el.getAttribute('data-src') || '';
        if (!src.includes('byteimg.com') && !src.includes('tos-alistore')) return;
        const hash = getHashFromUrl(src);
        if (!hash || seen.has(hash)) return;
        seen.add(hash);
        const rawUrl = getRawUrl(src);
        urls.push(rawUrl);
    });

    return urls;
}

// 获取最后一条消息的元信息（条数/文本/是否 AI/是否生成中），用于判断生成状态
function getLastMessageInfo() {
    const msgSelectors = [
        '.chat-message',
        '[class*="message-item"]',
        '[class*="msg-content"]',
        '[class*="message"]',
        '[class*="chat-item"]',
        '[class*="conversation-item"]',
        'div[data-message-id]',
        'div[data-testid*="message"]',
    ];
    let msgs = [];
    for (const sel of msgSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) { msgs = Array.from(found); break; }
    }
    if (msgs.length === 0) {
        return { count: 0, text: '', hasLoading: true, isAI: false };
    }
    const last = msgs[msgs.length - 1];
    const text = last.innerText || '';
    const html = last.innerHTML || '';
    const htmlLower = html.toLowerCase();
    const txtLower = text.toLowerCase();

    const classAttr = (last.getAttribute('class') || '').toLowerCase();
    const userKeywords = ['user', 'self', 'my-message', 'mine', 'sender-me'];
    const aiKeywords = ['assistant', 'model', 'ai-message', 'bot', 'agent', 'doubao', 'seedream', 'gpt'];
    const hasUserClass = userKeywords.some(k => classAttr.includes(k));
    const hasAiClass = aiKeywords.some(k => classAttr.includes(k));
    const isUser = hasUserClass && !hasAiClass;
    const isAI = !isUser;

    // 生成中判定：HTML 含 loading 类特征 或 文本含「生成中/思考中」等关键词
    const loadingHtml = ['loading', 'spinner', 'animate', 'skeleton', 'progress', 'pending']
        .some(k => htmlLower.includes(k));
    const loadingText = ['生成中', '思考中', '正在', '绘制中', '创作中']
        .some(k => txtLower.includes(k));
    const hasLoading = isAI && (loadingHtml || loadingText);

    return { count: msgs.length, text: text.slice(0, 120), hasLoading, isAI, isUser };
}

// ============================================================
// 豆包额度耗尽检测（「近 7 天额度已用完」/「当前时段额度已用完」）
//
// 时间边界：发送提示词前调用 markQuotaBaseline() 记录当时的
//   ① 最后一条可见消息的文本（锚点）+ 节点数量（仅作无文本时的兜底）
//   ② 已存在的提示条/toast 文本
// 判定用「文本锚点」而不是节点数量：在现有节点里找到仍含快照末条文本的那个
// 节点，只扫它之后的内容（它自己原地追加了内容也算）。原因：消息节点数会随
// 渲染抖动大幅变化（同一个会话几秒内 29 → 1、93 → 19），用数量做基线会把
// 正常新增误判成「会话被重建」，直接漏掉真正的额度提示。
// 退化策略：拿不到快照、或锚点文本在页面里彻底找不到（会话被换掉/清空）
//   时一律不判（返回 null），即「宁漏不误」——此时最后几条消息和提示条都可能
//   是上一轮遗留的旧证据。
// 任何异常都返回 null —— 额度检测绝不能影响生图主流程。
// ============================================================

// 锚点文本截断长度：快照存文本与判定比文本必须同一口径，否则会把「没变化」
// 误当成「变长了」（截断差异）而把上一轮的旧气泡重新纳入扫描。
var QUOTA_ANCHOR_MAX = 200;

// 状态用 var：内容脚本被重复注入时不因重复声明抛错
var quotaSnapshot = null;

// 归一化：去掉所有空白 + 全角转半角，避免「额度 ， 已用完」「额度\u00a0已用完」漏判
function normalizeQuotaText(t) {
    return String(t || '').replace(/[\s\u00a0]+/g, '').replace(/，/g, ',').replace(/：/g, ':');
}

// 命中规则（按优先级）：① /额度,?已用完/ ② 兜底 /升级到标准套餐/ 且 /预计.*恢复/
function isQuotaExhaustedText(t) {
    const n = normalizeQuotaText(t);
    if (!n) return false;
    if (/额度,?已用完/.test(n)) return true;
    return /升级到标准套餐/.test(n) && /预计.*恢复/.test(n);
}

// 恢复时间：从原文抓「预计 … 恢复」，原样返回（如「10月25日03:24」，不转 Date）
function parseQuotaResumeAt(t) {
    try {
        const n = normalizeQuotaText(t);
        const m = n.match(/预计(.{2,30}?)恢复/);
        return m ? m[1] : null;
    } catch (_) { return null; }
}

// 额度检测专用的消息节点（只给额度检测用，getLastMessageInfo 的选择器保持原样）
// 只用精确、稳定的选择器，并按稳定性排序取第一个非空：
//   div[data-message-id] > .chat-message > [class*="message-item"]
// 禁用 [class*="message"]：会同时命中 .message-list-* 容器、气泡外层和内层段落，
//   命中数随渲染抖动；禁用 [class*="chat-item"] / [class*="conversation-item"]：
//   会命中侧边栏会话列表（与对话区无关）。
// 精确选择器全空时才退化到 [class*="msg-content"] / div[data-testid*="message"]。
function collectQuotaMessageNodes() {
    try {
        const precise = ['div[data-message-id]', '.chat-message', '[class*="message-item"]'];
        for (const sel of precise) {
            const found = document.querySelectorAll(sel);
            if (found && found.length) return Array.from(found);
        }
        const loose = ['[class*="msg-content"]', 'div[data-testid*="message"]'];
        for (const sel of loose) {
            const found = document.querySelectorAll(sel);
            if (found && found.length) return Array.from(found);
        }
    } catch (_) {}
    return [];
}

// 快照用的锚点文本：最后一个「有文本且可见」的节点，截断到 QUOTA_ANCHOR_MAX
function lastQuotaMessageText(nodes) {
    let fallback = '';
    for (let i = nodes.length - 1; i >= 0; i--) {
        const el = nodes[i];
        if (!el) continue;
        const t = String(el.innerText || '');
        if (!t) continue;
        if (!fallback) fallback = t;                  // 兜底：不要求可见时取最后一条有文本的
        if (!isQuotaVisibleNode(el)) continue;
        return t.slice(0, QUOTA_ANCHOR_MAX);
    }
    return fallback.slice(0, QUOTA_ANCHOR_MAX);
}

// 排除：输入框内的文本（刚输入的提示词）与我们自己注入的节点
function isQuotaExcludedNode(el) {
    try {
        if (!el) return true;
        if (typeof el.closest === 'function') {
            if (el.closest('textarea, [contenteditable="true"], [role="textbox"]')) return true;
            if (el.closest('[data-polo-injected="1"]')) return true;
        }
        return false;
    } catch (_) { return true; }
}

function isQuotaVisibleNode(el) {
    try {
        if (!el) return false;
        if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
        if (typeof el.offsetHeight === 'number' && el.offsetHeight === 0) return false;
        return true;
    } catch (_) { return false; }
}

// 提示条 / toast / 弹窗：类名随站点改版，语义属性与常见类名段一起找
function collectQuotaNoticeTexts() {
    const out = [];
    try {
        const sels = [
            '[role="alert"]', '[role="alertdialog"]', '[role="dialog"]',
            '[class*="toast"]', '[class*="notice"]', '[class*="banner"]', '[class*="warning"]',
            '[class*="quota"]', '[class*="limit"]', '[class*="upgrade"]', '[class*="modal"]',
        ];
        for (const sel of sels) {
            let list = [];
            try { list = Array.from(document.querySelectorAll(sel) || []); } catch (_) { continue; }
            for (const el of list) {
                if (!isQuotaVisibleNode(el) || isQuotaExcludedNode(el)) continue;
                const t = String(el.innerText || el.textContent || '').trim();
                if (!t || t.length > 500) continue;
                if (out.indexOf(t) < 0) out.push(t);
            }
        }
    } catch (_) {}
    return out;
}

// 发送前调用：记录本轮的时间边界快照（发送失败/超时后只用它之后的内容判定）
function markQuotaBaseline() {
    try {
        const nodes = collectQuotaMessageNodes();
        quotaSnapshot = {
            count: nodes.length,
            lastText: lastQuotaMessageText(nodes),
            notices: collectQuotaNoticeTexts(),
            at: Date.now()
        };
    } catch (_) {
        quotaSnapshot = null;
    }
    return quotaSnapshot;
}

// 返回 null 或 { exhausted:true, text, resumeAt }
function detectQuotaExhausted() {
    try {
        const snap = quotaSnapshot;
        if (!snap) return null;                        // 无快照 → 不判
        const nodes = collectQuotaMessageNodes();
        const needle = String(snap.lastText || '');

        // ① 文本锚点：在现有节点里找仍包含快照末条文本的那个节点。
        //    从后往前找（等价于「取最后一个匹配」）：文本重复时靠后的那个才最接近
        //    快照的末条消息，从更早的位置起扫会把上一轮残留的额度气泡算成本轮证据。
        //    容忍流式追加：用 indexOf 包含匹配，不要求全等。
        let anchorIdx = -1;
        if (needle) {
            for (let i = nodes.length - 1; i >= 0; i--) {
                const t = String((nodes[i] && nodes[i].innerText) || '');
                if (t && t.indexOf(needle) >= 0) { anchorIdx = i; break; }
            }
            // 锚点彻底找不到 → 会话被换掉/清空，基线不可信 → 宁漏不误
            if (anchorIdx < 0) return null;
        } else {
            // 快照时没有可作锚点的文本（空会话/节点无文本）：只能按位置兜底，
            // 且节点数变少时依旧不判。
            const baseCount = (typeof snap.count === 'number' && snap.count > 0) ? snap.count : 0;
            if (nodes.length < baseCount) return null;
            anchorIdx = baseCount - 1;
        }

        // ② 从锚点之后开始扫；锚点节点原地追加了内容（文本比快照长）时，把它自己也纳入
        let from = anchorIdx + 1;
        if (anchorIdx >= 0) {
            const anchorEl = nodes[anchorIdx];
            const cur = String((anchorEl && anchorEl.innerText) || '').slice(0, QUOTA_ANCHOR_MAX);
            if (cur && cur !== needle) from = anchorIdx;
        }
        const candidates = nodes.slice(Math.max(0, from));

        for (let i = candidates.length - 1; i >= 0; i--) {
            const el = candidates[i];
            if (isQuotaExcludedNode(el)) continue;
            const text = String((el && el.innerText) || '');
            if (!isQuotaExhaustedText(text)) continue;
            return { exhausted: true, text: text.trim().slice(0, 200), resumeAt: parseQuotaResumeAt(text) };
        }

        const knownNotices = (snap && Array.isArray(snap.notices)) ? snap.notices : [];
        for (const t of collectQuotaNoticeTexts()) {
            if (knownNotices.indexOf(t) >= 0) continue;   // 发送前就存在的提示条不算本轮证据
            if (!isQuotaExhaustedText(t)) continue;
            return { exhausted: true, text: t.slice(0, 200), resumeAt: parseQuotaResumeAt(t) };
        }
        return null;
    } catch (_) {
        return null;
    }
}

// 轮询等待图片生成完成：以现有图为基准，检测到 >= minImages 张新图即返回；
// 超时（默认 10 分钟）返回已检测到的新图（可能不足）
async function waitForGenerationComplete(timeout = 600000, minImages = 4) {
    log(`等待图片生成完成（最多${Math.round(timeout/60000)}分钟，至少${minImages}张）...`);

    const existingUrls = getAllImageUrls();
    const existingSet = new Set(existingUrls);
    log(`已有图片 ${existingUrls.length} 张作为基准`);
    log(`💡 提示：如果只显示 ${minImages-1} 张，请手动向上/向下滚动显示第 ${minImages} 张`);

    const startTime = Date.now();
    let lastImageCount = existingUrls.length;

    while (Date.now() - startTime < timeout) {
        await sleep(2000);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        const currentUrls = getAllImageUrls();
        const currentCount = currentUrls.length;
        const newUrls = currentUrls.filter(u => !existingSet.has(u));

        if (currentCount > lastImageCount) {
            log(`[${elapsed}s] 图片增加: ${lastImageCount} → ${currentCount} (新图${newUrls.length}张)`);
            lastImageCount = currentCount;
        }

        if (newUrls.length >= minImages) {
            log(`✨ 检测到 ${newUrls.length} 张新图，满足要求`);
            await sleep(1500);
            return getAllImageUrls().filter(u => !existingSet.has(u));
        }

        if (elapsed % 15 === 0 && elapsed > 0) {
            log(`[${elapsed}s] 当前新图 ${newUrls.length}/${minImages} 张，请手动滚动显示更多`);
        }
    }

    log('⚠️ 等待超时', 'warn');
    const finalUrls = getAllImageUrls();
    const finalNew = finalUrls.filter(u => !existingSet.has(u));

    if (finalNew.length >= minImages) {
        log(`✅ 超时后检测到 ${finalNew.length} 张新图`);
        return finalNew;
    }

    log(`❌ 超时，只检测到 ${finalNew.length} 张新图`, 'error');
    return finalNew;
}

// 增量下载新图：按 white/black/gray/navy 顺序命名 row{rowNum}_{color}.png，
// 逐张发 downloadDoubaoImage 消息让 background 下载（自动建子文件夹）
async function downloadImagesIncremental(rowNum, timeout = 600000, totalImages = 4, execution = colorTask) {
    log(`等待 ${totalImages} 张图片出现（最多${Math.round(timeout/60000)}分钟）...`);

    const colorNames = ['white', 'black', 'gray', 'navy'];
    const existingUrls = new Set(getAllImageUrls());
    log(`已有 ${existingUrls.size} 张图片作为基准，已捕获无水印原图 ${rawUrlMap.size} 张`);
    log(`💡 提示：如果只显示 ${totalImages-1} 张，请手动向上/向下滚动显示第 ${totalImages} 张`);

    const startTime = Date.now();
    let allNewUrls = [];
    let lastImageCount = 0;
    let quotaHitStreak = 0;   // 额度耗尽连续命中次数（避免偶发误判打断正常生成）

    while (Date.now() - startTime < timeout) {
        await sleep(2000);
        if (colorTask !== execution || !isProcessing) return [];
        const pageText = String(document.body?.innerText || '');
        if (pageText.includes('出了点问题，请稍后重试')) {
            throw new Error('豆包生成失败：出了点问题，请稍后重试');
        }
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        // 额度耗尽：等图阶段连续 2 次命中才提前结束（结果为空，由 runColorTask 统一判定并回传）
        if (elapsed >= 30 && typeof detectQuotaExhausted === 'function') {
            const quotaHit = detectQuotaExhausted();
            quotaHitStreak = (quotaHit && quotaHit.exhausted) ? quotaHitStreak + 1 : 0;
            if (quotaHitStreak >= 2) {
                log('⚠️ 检测到豆包额度已用完，提前结束等图', 'warn');
                break;
            }
        }

        const currentUrls = getAllImageUrls();
        const newUrls = currentUrls.filter(u => {
            const h = getHashFromUrl(u);
            return h && !existingUrls.has(u);
        });

        if (newUrls.length > lastImageCount) {
            lastImageCount = newUrls.length;
            log(`[${elapsed}s] 图片增加: ${lastImageCount} 张`);
        }

        if (newUrls.length >= totalImages) {
            allNewUrls = newUrls.slice(0, totalImages);
            log(`✅ 检测到 ${allNewUrls.length} 张新图 (已达到目标 ${totalImages} 张)`);
            break;
        }

        if (elapsed % 15 === 0 && elapsed > 0) {
            log(`[${elapsed}s] 当前新图 ${newUrls.length}/${totalImages} 张，请手动滚动显示更多`);
        }
    }

    const downloads = [];

    if (allNewUrls.length === 0) {
        log('⚠️ 超时，未检测到足够新图', 'warn');
        return downloads;
    }

    log(`开始一次性下载 ${allNewUrls.length} 张图...`);

    for (let i = 0; i < allNewUrls.length; i++) {
        if (colorTask !== execution || !isProcessing) return downloads;
        const url = allNewUrls[i];
        const colorName = colorNames[i] || `color${i + 1}`;
        const filename = `row${rowNum}_${colorName}.png`;
        const hash = getHashFromUrl(url);
        const isRaw = rawUrlMap.has(hash);

        try {
            // 通过 Service Worker 下载（支持自动建子文件夹）
            const resp = await chrome.runtime.sendMessage({
                action: 'downloadDoubaoImage',
                url: url,
                filename: filename,
                rowNum: rowNum,
                batchId: execution && execution.batchId,
                executionId: execution && execution.executionId
            });
            if (resp?.ok) {
                downloads.push({ color: colorName, filename, ok: true, isRaw });
                log(`  ✓ ${i + 1}/${allNewUrls.length}: ${colorName} (${isRaw ? '无水印原图' : '水印图'}) → ${filename}`);
            } else {
                downloads.push({ color: colorName, filename, ok: false, error: resp?.error });
                log(`  ✗ ${colorName} 下载触发失败: ${resp?.error || '未知'}`, 'error');
            }
        } catch (e) {
            downloads.push({ color: colorName, filename, ok: false, error: e.message });
            log(`  ✗ ${colorName} 下载异常: ${e.message}`, 'error');
        }
    }

    const rawCount = downloads.filter(d => d.isRaw).length;
    log(`下载任务结束: 成功 ${downloads.filter(d => d.ok).length}/${downloads.length}，其中无水印 ${rawCount} 张`);
    return downloads;
}

// AI 换色主流程：切换模式 → 上传图 → 输提示词 → 发送 → 增量下载 4 张新图；
// 结束后发 colorTaskComplete 通知 background 并写回结果
async function runColorTask(task, onAccepted) {
    if (isProcessing) {
        log('已有任务进行中，跳过', 'warn');
        if (onAccepted) onAccepted({ ok: false, busy: true, error: '豆包正在执行上一个任务' });
        return;
    }
    isProcessing = true;
    colorTask = task;
    // 确认接收：让后台把"待派发身份"提升为"已接收执行身份"
    const accepted = await chrome.runtime.sendMessage({
        action: 'colorTaskAccepted',
        rowNum: task && task.rowNum,
        batchId: (task && task.batchId) || null,
        executionId: task && task.executionId
    }).catch(() => null);
    if (!accepted || !accepted.ok) {
        if (colorTask === task) isProcessing = false;
        if (onAccepted) onAccepted({ ok: false, error: '后台派发许可失效，未开始生成' });
        return { success: false, error: '后台派发许可失效，未开始生成' };
    }
    if (colorTask !== task || !isProcessing) {
        if (onAccepted) onAccepted({ ok: false, error: '已暂停' });
        return;
    }
    if (onAccepted) onAccepted({ ok: true, accepted: true });
    // 启动心跳，防止批量换色期间 SW 休眠丢失通知通道
    startHeartbeatForColorTask();

    const { imagePath, prompt, rowNum } = task;
    const results = { success: false, step: '', images: [], downloads: [] };

    try {
        // 上一款超时/失败后新派发的款：先开新对话，防迟到图串款（失败不阻断）
        if (task && task.freshChat === true) await startNewChat();
        if (colorTask !== task || !isProcessing) return;

        results.step = '切换图像生成模式';
        await switchToImageGenMode();
        await sleep(1000);
        if (colorTask !== task || !isProcessing) return;

        results.step = '上传图片';
        await uploadImage(imagePath);
        await sleep(2000);
        if (colorTask !== task || !isProcessing) return;

        results.step = '输入提示词';
        await typePrompt(prompt);
        await sleep(500);
        if (colorTask !== task || !isProcessing) return;

        results.step = '发送消息';
        // 时间边界：记录发送前的消息/提示快照，之后只认新增内容里的额度字样
        if (typeof markQuotaBaseline === 'function') markQuotaBaseline();
        await sendMessage();
        if (colorTask !== task || !isProcessing) return;

        results.step = '逐张下载';
        const downloads = await downloadImagesIncremental(rowNum, 600000, 4, task);
        results.downloads = downloads;
        results.success = downloads.filter(d => d.ok).length > 0;
        results.images = downloads.map(d => d.filename);

    } catch (e) {
        log('任务失败: ' + e.message, 'error');
        results.error = e.message;
    }

    // 额度耗尽判定：只在本轮一张图都没取到时做（取到图说明额度没拦住，避免误判）
    let quota = null;
    if (!results.success && typeof detectQuotaExhausted === 'function') {
        const q = detectQuotaExhausted();
        if (q && q.exhausted) {
            quota = { exhausted: true, text: q.text, resumeAt: q.resumeAt || null };
            log('⚠️ 豆包额度已用完' + (q.resumeAt ? `（预计 ${q.resumeAt} 恢复）` : ''), 'warn');
        }
    }

    if (colorTask !== task || !isProcessing) return;
    isProcessing = false;
    // 任务完成后停止心跳
    stopHeartbeatForColorTask();

    const completeMessage = {
        action: 'colorTaskComplete',
        results: results,
        rowNum: rowNum,
        // 由【本执行任务自身】携带批量标识返回：后台不得从可变的 pendingColorTask 反推身份
        batchId: (task && task.batchId) || null,
        executionId: task && task.executionId
    };
    // 未命中额度时不加该字段，保持旧消息结构（不影响旧逻辑）
    if (quota) completeMessage.quota = quota;
    chrome.runtime.sendMessage(completeMessage).catch(() => {});

    return results;
}

// 消息入口：startColorTask 触发换色流程；startAiEditTask 触发改图；
// getColorTaskStatus 查询任务状态
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'cancelColorTask') {
        if (!request.executionId || (colorTask && colorTask.executionId === request.executionId)) {
            colorTask = null;
            isProcessing = false;
            stopHeartbeatForColorTask();
        }
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === 'startColorTask') {
        // 忙碌时返回真实拒绝：页面不得把它当成"已接收"
        if (isProcessing) {
            log('已有任务进行中，拒绝接收新任务', 'warn');
            sendResponse({ ok: false, busy: true, error: '豆包正在执行上一个换色任务，未接收新任务' });
            return true;
        }
        runColorTask(request.task, sendResponse).catch(e => {
            isProcessing = false;
            sendResponse({ ok: false, error: e.message });
        });
        return true;
    }
    if (request.action === 'startAiEditTask') {
        if (isProcessing) { sendResponse({ ok: false, busy: true, error: '豆包仍在处理上一个任务' }); return true; }
        runAiEditTask(request.task);
        sendResponse({ ok: true, accepted: true });
        return true;
    }
    if (request.action === 'getColorTaskStatus') {
        sendResponse({ ok: true, isProcessing, task: colorTask });
        return true;
    }
});

// AI 改图变体：切换模式 + 上传图片 + 输提示词，但【不自动发送】，
// 等用户手动编辑提示词后自己发送
async function runAiEditTask(task) {
    if (isProcessing) {
        log('已有任务在处理中，跳过', 'warn');
        return;
    }
    isProcessing = true;
    colorTask = task;

    log('开始AI改图任务: ' + JSON.stringify(task));

    try {
        // 切换到图像生成模式
        const switched = await switchToImageGenMode();
        if (!switched) {
            log('切换模式失败，尝试直接上传', 'warn');
        }

        // 上传图片
        const uploaded = await uploadImage(task.imagePath);
        if (!uploaded) {
            log('图片上传失败', 'error');
            isProcessing = false;
            return;
        }

        // 输入提示词（但不自动发送，让用户自己编辑）
        await typePrompt(task.prompt);

        log('AI改图任务准备完成，等待用户编辑并发送');
        showToast('✅ 图片已上传，请编辑提示词后发送');

    } catch (e) {
        log('AI改图任务出错: ' + e.message, 'error');
    }

    isProcessing = false;
}

// 页面顶部居中 toast 提示
function showToast(msg) {
    const toast = document.createElement('div');
    toast.setAttribute('data-polo-injected', '1');   // 额度检测不得把我们自己注入的节点当页面提示
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:99999;';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

log('豆包AI换色脚本已加载');
