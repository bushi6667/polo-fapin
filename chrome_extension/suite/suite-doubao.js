/* ============================================================================
 * 套图 · 豆包执行器（在豆包标签页运行）
 *
 * 职责：素材上传 → 可靠输入合并提示词 → 明确发送一次 → 采集/等待本次新结果
 * 与换色的执行完全分开（suite-* 动作前缀），但共用同一个原生输入桥。
 *
 * 关键点（对齐参考扩展 content/doubao_generator.js）：
 *  - 输入：优先原生桥（background 经 chrome.debugger 调 Input.insertText），
 *    换行用 Shift+Enter；**绝不把普通 Enter 当作换行**
 *  - 发送：只在用户/调度明确要求时执行一次 send；输入阶段不触发提交
 *  - 基线：发送前记录当前会话已有图片 URL，之后只认 baseline 之外的新图
 *  - 上传：真正等待"上传完成"（预览缩略图出现），不靠固定 sleep 假定成功
 * ========================================================================== */
'use strict';

// 允许 background 在扩展重载后重复注入：只初始化一次，避免重复注册消息监听器
if (globalThis.__suiteDoubaoReady) { /* already injected */ } else {
globalThis.__suiteDoubaoReady = true;

const SuiteDoubao = (() => {
    const S = {
        bound: null,              // { taskId, fileKey, rowNum, executionId }
        baselineUrls: [],
        sending: false,
        sent: false
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const log = (m, t = 'info') => console.log(`[suite-doubao][${t}] ${m}`);

    /* ---------- 页面就绪 / 登录检查 ---------- */
    function findInput() {
        const sels = [
            '.ProseMirror[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea[placeholder]',
            'textarea'
        ];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el) return el;
        }
        return null;
    }

    function findSendButton() {
        const sels = [
            'button[data-testid="chat_input_send_button"]',
            'button[aria-label*="发送"]',
            'button[aria-label*="Send"]',
            '#flow-end-msg-send',
            '.send-btn'
        ];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el && !el.disabled) return el;
        }
        return null;
    }

    function isLoggedOut() {
        const t = (document.body && document.body.innerText) || '';
        return /登录|扫码登录|Sign in|Log in/i.test(t) && !findInput();
    }

    function probe() {
        const input = findInput();
        return {
            ok: !!input,
            hasInput: !!input,
            loggedOut: isLoggedOut(),
            sendButton: !!findSendButton(),
            url: location.href,
            imageCount: getAllImageUrls().length
        };
    }

    // 比例必须与配置一致，因此只认实际可见控件的文本，提示词/历史文本不算证据。
    // 模型不再按配置切换或比对：豆包侧保持其默认模型，只要存在可见的模型控件即通过。
    function verifySettings(settings) {
        const controls = Array.from(document.querySelectorAll('button,[role="combobox"]'))
            .filter(el => el.getClientRects().length && !el.disabled)
            .map(el => (el.innerText || el.textContent || '').trim());
        const model = String(settings.model || '').trim();
        const ratio = String(settings.ratio || '').trim();
        if (!ratio) throw new Error('任务缺少比例配置');
        if (!controls.some(text => text.toLowerCase().includes('seedream'))) throw new Error('未检测到豆包生图模型控件，未发送；请先确认已进入图像生成模式');
        // 比例控件文本形如「比例 1:1」，先归一化掉中文标签前缀再比对
        const normRatio = (t) => String(t).replace(/[^\d:.]/g, '');
        if (!controls.some(text => normRatio(text) === ratio)) throw new Error(`未能确认豆包当前比例为 ${ratio}，未发送；请先选择对应比例`);
        return { ok: true, model, ratio };
    }

    async function prepareSettings(settings) {
        const buttons=()=>Array.from(document.querySelectorAll('button,[role="combobox"]')).filter(e=>e.getClientRects().length&&!e.disabled);
        if(!buttons().some(e=>/seedream/i.test(e.textContent||''))) {
            const enter=buttons().find(e=>(e.textContent||'').trim()==='图像生成');
            if(enter)enter.click();
            for(let i=0;i<40&&!buttons().some(e=>/seedream/i.test(e.textContent||''));i++)await sleep(250);
        }
        const ratio=String(settings.ratio||'1:1');
        const control=buttons().find(e=>(e.textContent||'').replace(/\s+/g,'').startsWith('比例'));
        if(control && String(control.textContent).replace(/[^\d:.]/g,'')!==ratio) {
            control.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true}));
            await sleep(300);
            const menu=document.querySelector('[role="menu"]');
            const choice=menu&&Array.from(menu.querySelectorAll('button,span,[role="menuitem"]')).find(e=>(e.textContent||'').trim()===ratio);
            if(!choice)throw new Error('未找到比例选项 '+ratio+'，未发送');
            choice.click();
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
            await sleep(300);
        }
        return verifySettings(settings);
    }

    /* ---------- 图片采集 ---------- */
    // 仅取"对话区生成结果"类图片，排除头像/图标/表情/上传预览
    function getAllImageUrls() {
        const out = [];
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
            if (img.closest('[class*="upload"],[class*="preview"],[class*="file-item"],[data-role="user"],[data-message-role="user"],[data-testid*="user_message"],[class*="user-message"],[class*="userMessage"],[class*="message-user"]')) continue;
            const src = img.currentSrc || img.src || '';
            if (!src || src.startsWith('data:image/svg')) continue;
            // 按渲染尺寸判断：侧栏 20px 图标即使 naturalWidth 很大也不能算结果图
            const rect = img.getBoundingClientRect();
            if (Math.min(rect.width, rect.height) < 120) continue;  // 头像/图标
            // 对话区还会渲染原图和高清遮罩，不能仅凭尺寸认作新结果。
            if (!/(?:^|\s)(?:image-[\w-]+|result)(?:\s|$)/.test(String(img.className || ''))) continue;
            const cls = (img.className || '') + ' ' + ((img.closest('[class]') || {}).className || '');
            if (/avatar|icon|emoji|logo/i.test(cls)) continue;
            if (/upload/i.test(cls)) continue;                      // 上传预览
            out.push(src);
        }
        return Array.from(new Set(out));
    }

    function contentKeyOf(url) {
        try {
            const u = new URL(url, location.href);
            // 豆包图片 URL 携带尺寸参数：去掉尺寸类参数后作为"疑似同图"归并键
            const strip = ['w', 'h', 'width', 'height', 'resize', 'quality', 'x-oss-process'];
            for (const k of strip) u.searchParams.delete(k);
            return u.origin + u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
        } catch (_) { return url; }
    }

    /* ---------- 上传素材 ---------- */
    async function urlToFile(url, name) {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`素材读取失败 HTTP ${resp.status}：${name}`);
        const blob = await resp.blob();
        if (!blob || !blob.size) throw new Error(`素材为空：${name}`);
        return new File([blob], name, { type: blob.type || 'image/png' });
    }

    async function uploadAssets(assets) {
        if (!assets || !assets.length) throw new Error('没有素材可上传');
        const input = findInput();
        if (!input) throw new Error('豆包输入框未就绪，无法上传素材');
        const fileInput = document.querySelector('input[type="file"]');
        if (!fileInput) throw new Error('未找到豆包的文件选择控件，无法上传素材');

        const files = [];
        for (const a of assets) files.push(await urlToFile(a.url, a.filename || (a.color + '.png')));

        // 豆包新版预览缩略图不带 upload/preview/file-item 类名，只有 blob:/data: 的 <img>，
        // 因此按"输入区内尺寸≥40px 的本地图片"来计数，避免把头像/图标算进去。
        const previewCount = () => {
            const surface = document.querySelector('.guidance-input-surface')
                || document.querySelector('#input-engine-container')
                || document.body;
            return Array.from(surface.querySelectorAll('img')).filter(img => {
                const src = img.currentSrc || img.src || '';
                if (!/^(blob:|data:image)/.test(src) || src.startsWith('data:image/svg')) return false;
                const r = img.getBoundingClientRect();
                return Math.min(r.width, r.height) >= 40;
            }).length;
        };
        const beforeCount = previewCount();
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        // 实际等待"上传完成"：预览数量增加，而不是固定等待后假定成功
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await sleep(500);
            const pending = document.querySelector('[role="progressbar"], [class*="uploading"], [class*="upload-error"]');
            const now = previewCount();
            if (now >= beforeCount + files.length && !pending) {
                return { ok: true, uploaded: files.length, previews: now, waitedMs: 120000 - (deadline - Date.now()) };
            }
        }
        throw new Error(`上传未在 120 秒内完成（期望 ${files.length} 张，实际预览 ${previewCount() - beforeCount} 张）`);
    }

    /* ---------- 输入（原生桥优先，绝不误提交） ---------- */
    function nativeInput(command, character) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'doubao-native-input', command, character }, (resp) => {
                const err = chrome.runtime.lastError;
                if (err || !resp || resp.success !== true) reject(new Error(err ? err.message : (resp && resp.error) || '原生输入无响应'));
                else resolve();
            });
        });
    }

    function readInputText(el) {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
        return String(el.innerText || '');
    }

    async function typePrompt(text) {
        const input = findInput();
        if (!input) throw new Error('豆包输入框未就绪，无法输入提示词');
        input.focus();

        await nativeInput('begin');
        try {
            if (readInputText(input)) await nativeInput('clear');
            // 逐字输入；换行用 Shift+Enter（原生桥内部实现），绝不发普通 Enter
            for (const ch of Array.from(String(text))) {
                if (ch === '\n') await nativeInput('character', '\n');
                else await nativeInput('character', ch);
            }
        } finally {
            await nativeInput('end').catch(() => {});
        }

        // 实际校验输入是否完整，不假定成功
        await sleep(300);
        const got = readInputText(input).replace(/\u00a0/g, ' ').trim();
        const want = String(text).replace(/\u00a0/g, ' ').trim();
        // ProseMirror 的软换行可能表现为双换行；只归一空白，不放过文字缺失或替换。
        const comparable=value=>value.replace(/\s+/g,' ').trim();
        if (comparable(got) !== comparable(want)) {
            throw new Error(`提示词输入不完整（期望 ${want.length} 字，实际 ${got.length} 字），已取消发送`);
        }
        return { ok: true, length: got.length };
    }

    /* ---------- 发送（只允许显式调用一次） ---------- */
    async function sendOnce() {
        if (S.sending || S.sent) throw new Error('该执行已发送或正在发送，拒绝重复发送');
        S.sending = true;
        try {
            const input = findInput();
            if (!input) throw new Error('输入框消失，未发送');
            const before = getAllImageUrls();
            const btn = findSendButton();
            if (btn) {
                S.sent = true; // ambiguous send failures must not be retried automatically
                btn.click();
            } else {
                throw new Error('未找到可用发送按钮，未发送');
            }
            // 发送证据：出现"生成中"或消息数增加
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                await sleep(400);
                const now = getAllImageUrls();
                const busy = !!document.querySelector('[class*="loading"], [class*="generating"], [class*="typing"]');
                if (busy || now.length !== before.length) {
                    return { ok: true, baselineUrls: before, evidence: busy ? 'generating' : 'images-changed' };
                }
            }
            throw new Error('发送后 15 秒内未见生成中或结果变化，无法确认已发送');
        } finally {
            S.sending = false;
        }
    }

    /* ---------- 等待并采集本次新结果 ---------- */
    async function waitForNewImages(baselineUrls, expectCount, timeoutMs) {
        const base = Array.isArray(baselineUrls) ? baselineUrls : S.baselineUrls;
        const deadline = Date.now() + (timeoutMs || 600000);
        let last = [];
        while (Date.now() < deadline) {
            await sleep(2000);
            // 豆包在视口外保留SVG占位图；逐张滚入视口触发真实图片加载。
            for(const image of document.querySelectorAll('img')) {
                if(String(image.className||'').startsWith('image-') && String(image.currentSrc||image.src||'').startsWith('data:image/svg')) {
                    image.scrollIntoView({block:'center',behavior:'instant'});
                    await sleep(400);
                }
            }
            const all = getAllImageUrls();
            const fresh = all.filter(u => !base.includes(u));
            last = fresh;
            const busy = !!document.querySelector('[class*="loading"], [class*="generating"], [class*="typing"]');
            if (fresh.length >= expectCount && !busy) break;
            if (!busy && fresh.length > 0 && Date.now() + 8000 > deadline) break;
        }
        // 归并"同图不同尺寸/链接"的疑似重复（内容指纹由页面侧进一步确认）
        const groups = new Map();
        for (const u of last) {
            const k = contentKeyOf(u);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(u);
        }
        const images = Array.from(groups.values()).map(g => g[0]);
        return {
            ok: images.length > 0,
            images,
            rawCount: last.length,
            dedupedByUrlKey: images.length,
            mergedGroups: Array.from(groups.values()).filter(g => g.length > 1).length,
            baselineCount: base.length
        };
    }

    // 在豆包页面读取带签名的结果，不让file助手页跨源抓取CDN。
    // 返回自包含图片，后续识别/缓存/恢复都不再依赖临时服务器或过期URL。
    async function materializeImages(urls) {
        document.dispatchEvent(new CustomEvent('_poloRawReplay'));
        const result = [];
        for (const previewUrl of urls) {
            const url = typeof getRawUrl === 'function' ? getRawUrl(previewUrl) : previewUrl;
            const parsed = new URL(url);
            if (!parsed.pathname.includes('image_raw') && !parsed.searchParams.has('image_raw')) throw new Error('尚未取得本次图片的无水印原图，已保留生成结果，请仅重试取图，不会下载带水印预览图');
            let response;
            try { response = await fetch(url, { credentials: 'omit' }); }
            catch (_) { throw new Error('结果图片请求失败：原对话图片链接可能已失效，请恢复已有结果，勿重新生成'); }
            if (!response.ok) throw new Error(`结果图片读取失败 HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.size || blob.size > 20 * 1024 * 1024 || !/^image\//.test(blob.type)) throw new Error('结果图片为空、过大或不是图片');
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('结果图片编码失败'));
                reader.readAsDataURL(blob);
            });
            result.push(dataUrl);
        }
        return result;
    }

    /* ---------- 消息入口 ---------- */
    async function pollNewImages(baselineUrls,expectCount) {
        for(const image of document.querySelectorAll('img'))if(String(image.className||'').startsWith('image-')&&String(image.src||'').startsWith('data:image/svg')){image.scrollIntoView({block:'center',behavior:'instant'});await sleep(400);}
        const base=baselineUrls||S.baselineUrls, images=getAllImageUrls().filter(u=>!base.includes(u));
        const busy=!!document.querySelector('[class*="generating"],[class*="typing"]');
        if(images.length!==expectCount||busy)return {ready:false,count:images.length};
        return {ready:true,images:await materializeImages(images),rawCount:images.length,baselineCount:base.length,mergedGroups:0};
    }
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const a = request && request.action;
        if (!a || a.indexOf('suite-') !== 0) return;
        (async () => {
            try {
                if (a === 'suite-probe') { sendResponse(Object.assign({ success: true }, probe())); return; }
                if(a==='suite-recover-bind') {
                    if(S.bound&&S.bound.taskId!==request.binding?.taskId)throw new Error('豆包页已绑定其他任务，不能恢复到此对话');
                    S.bound=request.binding;S.sent=true;S.baselineUrls=request.baselineUrls||[];sendResponse({success:true});return;
                }
                if (a === 'suite-baseline') {
                    if (S.bound && S.bound.taskId === request.binding?.taskId && S.sent) throw new Error('该任务已经发送，拒绝重置发送状态');
                    S.bound = request.binding || null;
                    S.sent = false;
                    S.baselineUrls = getAllImageUrls();
                    sendResponse({ success: true, baselineUrls: S.baselineUrls });
                    return;
                }
                if (!S.bound || !request.binding || S.bound.taskId !== request.binding.taskId || S.bound.fileKey !== request.binding.fileKey || S.bound.rowNum !== request.binding.rowNum) throw new Error('套图执行绑定不匹配');
                if (a === 'suite-settings') { sendResponse({ success: true, result: await prepareSettings(request.settings || {}) }); return; }
                if (a === 'suite-upload') { sendResponse({ success: true, result: await uploadAssets(request.assets) }); return; }
                if (a === 'suite-type') { sendResponse({ success: true, result: await typePrompt(request.text) }); return; }
                if (a === 'suite-send') { sendResponse(Object.assign({ success: true }, await sendOnce())); return; }
                if(a==='suite-poll'){sendResponse({success:true,result:await pollNewImages(request.baselineUrls,request.expectCount||5)});return;}
                if (a === 'suite-wait') {
                    const r = await waitForNewImages(request.baselineUrls, request.expectCount || 5, request.timeoutMs);
                    if (r.images && r.images.length === (request.expectCount || 5)) r.images = await materializeImages(r.images);
                    sendResponse({ success: true, result: r });
                    return;
                }
                sendResponse({ success: false, error: '未知套图动作：' + a });
            } catch (e) {
                log(e.message, 'error');
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    });

    globalThis.SuiteDoubao = { probe, verifySettings, getAllImageUrls, materializeImages, uploadAssets, typePrompt, sendOnce, waitForNewImages, findInput, findSendButton };
    log('套图执行器已注入');
})();
}
