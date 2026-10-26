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
    // ---------- 账号原语（只对调用方负责，不参与任何轮询/自动流程） ----------
    if (request.action === 'doubaoListAccounts') {
        listDoubaoAccounts().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'doubaoQuotaPercent') {
        readQuotaPercent().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (request.action === 'doubaoSwitchAccount') {
        switchDoubaoAccount(request.name).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
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

// ============================================================
// 豆包账号切换（底层原语：只提供「能被调用 / 能切换 / 能回报」，不含自动流程）
//
// 已确认事实：
//   ① 长时间未登录的账号切过去会要求重新登录（弹登录墙/扫码）→ 必须如实回报 needLogin，
//      绝不能把「落在登录墙」当成切换成功
//   ② 切号后页面会整页重新加载 → 重载会销毁本文件的 JS 环境与消息通道，
//      所以 background 侧对「通道被关闭」另有一条复核路径（见 background.js）
//   ③ 账号名由用户自己改成互不相同 → 直接按名字匹配即可，不依赖顺序/下标
//
// DOM 契约（只认 data-testid / role / data-slot，禁用每次渲染都变的 radix-:modern-js-* id）：
//   头像按钮   img[data-testid="chat_header_avatar_button"] 所在的 button
//   一级菜单   [data-testid="chat_header_menu"]
//   账号行     div[role="menuitem"][data-testid="avatar_menu_account_row"]
//   更多账号   [data-slot="dropdown-menu-sub-trigger"] 且文案含「更多账号」
//   （添加账号 avatar_menu_add_account / 退出登录 setup_logout 本文件不点，留作后续接线）
// ============================================================

var DOUBAO_MENU_SEL = '[data-testid="chat_header_menu"]';
var DOUBAO_ACCOUNT_ROW_SEL = 'div[role="menuitem"][data-testid="avatar_menu_account_row"]';
// 行尾套餐字样（如「体验套餐」）：名字与套餐常挤在同一个 span 里，必须切开
var DOUBAO_PLAN_TAIL_RE = /[\s·|]*((?:体验|标准|专业|旗舰|高级|基础|免费)套餐|免费版|体验版|标准版|专业版|旗舰版|会员版)\s*$/;

function isDoubaoVisible(el) {
    try {
        if (!el) return false;
        if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
        if (typeof el.offsetHeight === 'number' && el.offsetHeight <= 0) return false;
        return true;
    } catch (_) { return false; }
}

// 头像按钮：优先 img[data-testid=chat_header_avatar_button] 的 button 祖先
function findDoubaoAvatarButton() {
    try {
        const img = document.querySelector('img[data-testid="chat_header_avatar_button"]');
        const host = img || document.querySelector('[data-testid="chat_header_avatar_button"]');
        if (!host) return null;
        const btn = (typeof host.closest === 'function' && host.closest('button')) || host;
        return isDoubaoVisible(btn) ? btn : null;
    } catch (_) { return null; }
}

// 去掉行尾套餐字样（名字/套餐同 span 时用）
function stripDoubaoPlanTail(text) {
    try {
        const t = String(text || '').trim();
        const m = t.match(DOUBAO_PLAN_TAIL_RE);
        return m ? t.slice(0, t.length - m[0].length).trim() : t;
    } catch (_) { return ''; }
}

// 当前账号名：优先读头像按钮上的名字（打开菜单时它就是当前账号），不依赖 ✓ 图标
function readDoubaoHeaderName() {
    try {
        const btn = findDoubaoAvatarButton();
        if (!btn) return '';
        let raw = String(btn.innerText || '').trim();
        if (!raw) {
            const img = btn.querySelector('img');
            const alt = img ? String(img.getAttribute('alt') || '').trim() : '';
            if (alt && !/^(头像|avatar|user\s*avatar)$/i.test(alt)) raw = alt;
        }
        if (!raw) raw = String(btn.getAttribute('aria-label') || btn.getAttribute('title') || '').trim();
        const first = raw.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
        return stripDoubaoPlanTail(first.replace(/^(当前账号|账号)[:：]?/, '').trim());
    } catch (_) { return ''; }
}

function isAccountMenuOpen() {
    try {
        const el = document.querySelector(DOUBAO_MENU_SEL);
        return !!el && isDoubaoVisible(el);
    } catch (_) { return false; }
}

async function waitAccountMenuClosed(ms) {
    try {
        const start = Date.now();
        while (Date.now() - start < ms) {
            if (!isAccountMenuOpen()) return true;
            await sleep(80);
        }
        return !isAccountMenuOpen();
    } catch (_) { return false; }
}

// 账号行/子菜单触发器是 radix menu item：真实选中走 pointerup（再跟 click），
// 只发 mouse 事件可能整条链都不触发。这里补 pointerdown/pointerup，
// 原 nativeMouseClick 一个字不改（生图主流程继续用它）。
function activateDoubaoTarget(el) {
    if (!el) return false;
    try {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        // pointerType 缺省是 ''（构造器不认鼠标），radix 会同时认 pointerup 和 click → 同一行被选两次。
        // 显式声明鼠标指针，事件序列保持不变（鼠标路径仍靠 click 收尾）。
        const pointerExtra = { pointerType: 'mouse', pointerId: 1, isPrimary: true, buttons: 1 };
        const PointerCtor = (typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
        const fire = (type, Ctor, extra) => {
            try { el.dispatchEvent(new Ctor(type, extra ? Object.assign({}, base, extra) : base)); } catch (_) {}
        };
        fire('pointerdown', PointerCtor, pointerExtra);
        fire('mousedown', MouseEvent);
        fire('pointerup', PointerCtor, pointerExtra);
        fire('mouseup', MouseEvent);
        fire('click', MouseEvent);
        return true;
    } catch (e) {
        try { el.click(); return true; } catch (_) { return false; }
    }
}

// 打开一级账号菜单：点头像 → 等 [data-testid=chat_header_menu] 可见，超时 3s 返回 false
async function openAccountMenu() {
    try {
        if (isAccountMenuOpen()) return true;
        const btn = findDoubaoAvatarButton();
        if (!btn) { log('未找到头像按钮，无法打开账号菜单', 'warn'); return false; }
        nativeMouseClick(btn);
        const start = Date.now();
        while (Date.now() - start < 3000) {
            if (isAccountMenuOpen()) { await sleep(150); return true; }   // 再多等 150ms 让账号行渲染完
            await sleep(100);
        }
        log('账号菜单 3s 内未出现', 'warn');
        return false;
    } catch (e) {
        log('打开账号菜单异常: ' + e.message, 'warn');
        return false;
    }
}

// 关闭账号菜单：先 Esc（与页面其它浮层同一关法），关不掉再点空白。
// 只派发指针事件、不调 el.click()，避免真的触发页面上某个按钮（不影响输入框与主流程）
async function closeAccountMenu() {
    try {
        if (!isAccountMenuOpen()) return true;
        const fireEsc = (type) => {
            try {
                document.body.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true
                }));
            } catch (_) {}
        };
        fireEsc('keydown');
        await sleep(80);
        fireEsc('keyup');
        if (await waitAccountMenuClosed(700)) return true;

        const blank = { bubbles: true, cancelable: true, clientX: 2, clientY: 2, button: 0, view: window };
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
            try {
                const Ev = (t.indexOf('pointer') === 0 && typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
                document.body.dispatchEvent(new Ev(t, blank));
            } catch (_) {}
        }
        if (await waitAccountMenuClosed(700)) return true;
        log('账号菜单未关闭（不阻断后续操作）', 'warn');
        return false;
    } catch (_) {
        return false;
    }
}

// 单行解析：名字取「第一个有文本的 span」，并切出行尾套餐字样
function parseDoubaoAccountRow(row) {
    try {
        let name = '';
        for (const sp of row.querySelectorAll('span')) {
            const t = String(sp.innerText || sp.textContent || '').trim();
            if (t) { name = t; break; }
        }
        const full = String(row.innerText || '').trim();
        if (!name) name = (full.split('\n')[0] || '').trim();

        let plan = '';
        const tail = name.match(DOUBAO_PLAN_TAIL_RE);
        if (tail) {
            plan = tail[1];
            name = name.slice(0, name.length - tail[0].length).trim();
        }
        if (!plan && full) {
            for (const line of full.split('\n').map(s => s.trim()).filter(Boolean)) {
                if (!line || line === name || line === '✓') continue;
                if (line.indexOf(name) >= 0) {
                    const left = line.replace(name, '').trim();
                    if (left && left !== '✓') plan = left;
                } else if (/套餐|会员|版$/.test(line)) {
                    plan = line;
                }
                if (plan) break;
            }
        }
        return { name, plan };
    } catch (_) { return { name: '', plan: '' }; }
}

function collectDoubaoAccountRows() {
    const out = [];
    try {
        for (const row of document.querySelectorAll(DOUBAO_ACCOUNT_ROW_SEL)) {
            if (!isDoubaoVisible(row)) continue;
            const parsed = parseDoubaoAccountRow(row);
            if (!parsed.name) continue;
            parsed.el = row;
            out.push(parsed);
        }
    } catch (_) {}
    return out;
}

function findDoubaoMoreAccountsTrigger() {
    try {
        for (const el of document.querySelectorAll('[data-slot="dropdown-menu-sub-trigger"]')) {
            if (!isDoubaoVisible(el)) continue;
            if (String(el.innerText || el.textContent || '').indexOf('更多账号') >= 0) return el;
        }
    } catch (_) {}
    return null;
}

async function waitDoubaoAccountRowsAbove(min, ms) {
    try {
        const start = Date.now();
        while (Date.now() - start < ms) {
            if (collectDoubaoAccountRows().length > min) return true;
            await sleep(100);
        }
        return false;
    } catch (_) { return false; }
}

function dispatchDoubaoHover(el) {
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
        try {
            const Ev = (t.indexOf('pointer') === 0 && typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ev(t, { bubbles: !/enter$/.test(t), cancelable: true, view: window }));
        } catch (_) {}
    }
}

// 展开「更多账号」子菜单：不同版本靠 click 或 hover 触发，两种都试，以「行数变多」为成功信号
async function expandDoubaoMoreAccounts(trigger) {
    const before = collectDoubaoAccountRows().length;
    try {
        activateDoubaoTarget(trigger);
        if (await waitDoubaoAccountRowsAbove(before, 1200)) return collectDoubaoAccountRows();
        dispatchDoubaoHover(trigger);
        if (await waitDoubaoAccountRowsAbove(before, 1500)) return collectDoubaoAccountRows();
    } catch (e) {
        log('展开「更多账号」异常: ' + e.message, 'warn');
    }
    return collectDoubaoAccountRows();
}

// 当前账号解析：先按名字比对头像上的名字；名字读不到时退化用「菜单里唯一带图标的那一行」
function resolveDoubaoCurrentName(rows, headerName) {
    let current = String(headerName || '').trim();
    try {
        if (!current || !rows.some(r => r.name === current)) {
            const withIcon = rows.filter(r => r.el && r.el.querySelector('svg'));
            if (withIcon.length === 1) current = withIcon[0].name;
        }
    } catch (_) {}
    return current;
}

// 列账号：打开菜单 → 一级行 → 有「更多账号」再展开收集子菜单行 → 关闭菜单
// loginWall：与 ok 独立。ok:false + loginWall:true 表示「页面是登录墙，压根读不到账号」，
// 调用方（background 复核）必须按 needLogin 报，不能报成「读不到账号列表」。
async function listDoubaoAccounts() {
    try {
        const opened = await openAccountMenu();
        if (!opened) {
            return { ok: false, error: '未能打开账号菜单（未找到头像按钮或菜单未出现）', loginWall: detectLoginWall().needLogin };
        }
        await sleep(200);

        const headerName = readDoubaoHeaderName();
        const rows = collectDoubaoAccountRows();

        // 子菜单行与一级行同一个 data-testid：只能靠「展开前已见过的名字」去重
        const trigger = findDoubaoMoreAccountsTrigger();
        if (trigger) {
            const seen = new Set(rows.map(r => r.name));
            for (const r of await expandDoubaoMoreAccounts(trigger)) {
                if (seen.has(r.name)) continue;
                seen.add(r.name);
                rows.push(r);
            }
        }

        const current = resolveDoubaoCurrentName(rows, headerName);
        await closeAccountMenu();
        const loginWall = detectLoginWall().needLogin;   // 菜单关掉后再判，避免浮层干扰弱特征

        if (!rows.length) return { ok: false, error: '账号菜单里没有读到账号行', loginWall };
        return {
            ok: true,
            current: current || '',
            loginWall,
            accounts: rows.map(r => ({
                name: r.name,
                plan: r.plan || '',
                isCurrent: !!current && r.name === current
            }))
        };
    } catch (e) {
        await closeAccountMenu();
        return { ok: false, error: e.message, loginWall: detectLoginWall().needLogin };
    }
}

// 「近 7 天消耗消耗 100%」：文案可能重复「消耗」、可能跨 span 换行。
// 先抹掉所有空白，再从「近7天消耗」之后最多 12 个非数字字符内抓百分数。
function parseDoubaoQuotaPercent(text) {
    try {
        const flat = String(text || '').replace(/[\s\u00a0]+/g, '');
        const m = flat.match(/近7天消耗\D{0,12}?(\d{1,3})%/);
        if (!m) return null;
        const v = parseInt(m[1], 10);
        return (Number.isFinite(v) && v >= 0 && v <= 100) ? v : null;
    } catch (_) { return null; }
}

// 读额度百分比：只在被调用时开一次菜单（不进任何轮询循环）
async function readQuotaPercent() {
    try {
        const opened = await openAccountMenu();
        if (!opened) {
            return { ok: false, error: '未能打开账号菜单（未找到头像按钮或菜单未出现）', loginWall: detectLoginWall().needLogin };
        }
        const menu = document.querySelector(DOUBAO_MENU_SEL);
        const text = String((menu && menu.innerText) || '');
        await closeAccountMenu();
        const loginWall = detectLoginWall().needLogin;
        const percent = parseDoubaoQuotaPercent(text);
        if (percent === null) return { ok: false, error: '账号菜单里没读到「近 7 天消耗 …%」', loginWall };
        return { ok: true, percent, loginWall };
    } catch (e) {
        await closeAccountMenu();
        return { ok: false, error: e.message, loginWall: detectLoginWall().needLogin };
    }
}

// 登录墙识别：强特征不看输入框，弱特征（单个「登录」）必须配合「没有输入框/有登录按钮」
var DOUBAO_LOGIN_STRONG = ['扫码登录', '手机号登录', '验证码登录', '密码登录', '登录后继续', '登录/注册', '请先登录'];
var DOUBAO_LOGIN_WEAK = ['请登录', '立即登录', '登录'];

function findDoubaoLoginButton() {
    try {
        for (const el of document.querySelectorAll('button, [role="button"], a')) {
            if (!isDoubaoVisible(el)) continue;
            const t = String(el.innerText || el.textContent || '').trim();
            if (!t || t.length > 12) continue;
            if (/^(立即登录|登录|扫码登录|登录\/注册|手机号登录)$/.test(t)) return el;
        }
    } catch (_) {}
    return null;
}

function detectLoginWall() {
    try {
        const compact = String((document.body && document.body.innerText) || '').replace(/[\s\u00a0]+/g, '');
        for (const s of DOUBAO_LOGIN_STRONG) {
            if (compact.indexOf(s) >= 0) return { needLogin: true, hint: '页面出现「' + s + '」' };
        }
        const hasInput = !!findChatInput();
        const loginBtn = findDoubaoLoginButton();
        // 弱特征（单个「登录/请登录」）必须配合「输入框消失」才算登录墙，
        // 否则正常页面里任何一处带「登录」的小字都会被误判成墙 → 会挡住切号
        for (const s of DOUBAO_LOGIN_WEAK) {
            if (compact.indexOf(s) >= 0 && !hasInput) {
                return { needLogin: true, hint: '页面出现「' + s + '」且输入框消失' };
            }
        }
        if (!hasInput && loginBtn) return { needLogin: true, hint: '聊天输入框消失且存在登录按钮' };
        return { needLogin: false, hint: '' };
    } catch (_) {
        return { needLogin: false, hint: '' };   // 识别失败不得阻断调用方
    }
}

// 等切号后的整页重载：href 变化 / 消息节点归零 / readyState loading→complete，
// 三者任一命中即认为已重载；最长 25s。
// 注意：整页重载会销毁本文件，实际调用中这里常常等不到返回，
//       由 background.js 的通道关闭复核路径兜底。
async function waitDoubaoPageReload(beforeHref, beforeCount, timeout) {
    try {
        const start = Date.now();
        let sawLoading = false;
        while (Date.now() - start < timeout) {
            try {
                if (location.href !== beforeHref) return true;
                const rs = document.readyState;
                if (rs === 'loading') sawLoading = true;
                else if (sawLoading && rs === 'complete') return true;
                if (beforeCount > 0 && collectQuotaMessageNodes().length === 0) return true;
            } catch (_) {}
            await sleep(200);
        }
        return false;
    } catch (_) { return false; }
}

// 重载后复核当前账号：先读头像（不必开菜单），读不到再开菜单按名字/图标兜底
async function readCurrentDoubaoAccountName() {
    try {
        const direct = readDoubaoHeaderName();
        if (direct) return direct;
        const list = await listDoubaoAccounts();
        if (list && list.ok && list.current) return list.current;
    } catch (_) {}
    return '';
}

// 切号安全阀：套图（suite-doubao.js 的 IIFE）不设 isProcessing，只能靠它自己在用的
// DOM 忙类判忙。选择器与套图保持一致（[class*="generating"], [class*="typing"]），可见才算忙。
var DOUBAO_BUSY_SEL = '[class*="generating"], [class*="typing"]';

function isDoubaoBusyInDom() {
    try {
        for (const el of document.querySelectorAll(DOUBAO_BUSY_SEL)) {
            if (isDoubaoVisible(el)) return true;
        }
    } catch (_) {}
    return false;
}

// 完整切号流程：登录墙 → 找行 → 同号判断 → 点击 → 等重载 → 再查登录墙 → 复核用户名
async function switchDoubaoAccount(name) {
    const target = String(name == null ? '' : name).trim();
    try {
        if (!target) return { ok: false, error: '缺少账号名' };
        // 换色/改图执行中（isProcessing）或套图生成中（DOM 忙）都不能切号：
        // 整页重载会把执行中的任务连页面一起销毁
        if (isProcessing || isDoubaoBusyInDom()) {
            return { ok: false, busy: true, error: '豆包正在生成中，暂不切换账号' };
        }

        // a) 已经是登录墙：如实回报，不做任何点击
        const wall = detectLoginWall();
        if (wall.needLogin) return { ok: false, needLogin: true, error: '当前页已是登录墙', hint: wall.hint };

        // b) 打开菜单，先一级行找，找不到再展开「更多账号」
        const opened = await openAccountMenu();
        if (!opened) return { ok: false, error: '未能打开账号菜单（未找到头像按钮或菜单未出现）' };
        await sleep(200);

        const headerName = readDoubaoHeaderName();
        const rows = collectDoubaoAccountRows();
        let hit = rows.find(r => r.name === target) || null;
        if (!hit) {
            const trigger = findDoubaoMoreAccountsTrigger();
            if (trigger) {
                const seen = new Set(rows.map(r => r.name));
                for (const r of await expandDoubaoMoreAccounts(trigger)) {
                    if (seen.has(r.name)) continue;
                    seen.add(r.name);
                    rows.push(r);
                }
                hit = rows.find(r => r.name === target) || null;
            }
        }
        if (!hit) {
            await closeAccountMenu();
            return { ok: false, error: '未找到账号：' + target, accounts: rows.map(r => r.name) };
        }

        // c) 目标就是当前账号：不切，明确回 sameAccount
        const current = resolveDoubaoCurrentName(rows, headerName);
        if (current && current === target) {
            await closeAccountMenu();
            return { ok: false, sameAccount: true, current, error: '已经是该账号' };
        }

        // d) 点目标行 → 等重载（最长 25s）→ 再额外等 2s 让输入框出现
        //    点之前再判一次忙：从入口到找到账号行可能已过去数秒，期间套图可能刚开跑
        if (isProcessing || isDoubaoBusyInDom()) {
            await closeAccountMenu();
            return { ok: false, busy: true, error: '豆包正在生成中，暂不切换账号' };
        }
        const beforeHref = location.href;
        const beforeCount = collectQuotaMessageNodes().length;
        activateDoubaoTarget(hit.el);
        const reloaded = await waitDoubaoPageReload(beforeHref, beforeCount, 25000);
        await sleep(2000);

        // e) 重载后仍落在登录墙 = 该账号需要重新登录（不能当成功）
        const afterWall = detectLoginWall();
        if (afterWall.needLogin) {
            await closeAccountMenu();
            return { ok: false, needLogin: true, reloaded, error: '该账号需要重新登录', hint: afterWall.hint };
        }

        // f) 用头像上的用户名复核
        const actual = await readCurrentDoubaoAccountName();
        if (actual && actual === target) return { ok: true, name: target, reloaded };
        if (!reloaded) {
            return { ok: false, reloaded: false, actual, error: '点击后 25s 内未检测到页面重载（切换可能未生效）' };
        }
        return { ok: false, reloaded, actual, error: '切换后用户名不匹配（实际：' + (actual || '未知') + '）' };
    } catch (e) {
        // g) 任何异常都关掉菜单兜底，避免浮层挡住后续生图操作
        try { await closeAccountMenu(); } catch (_) {}
        return { ok: false, error: e.message };
    }
}

log('豆包AI换色脚本已加载');
