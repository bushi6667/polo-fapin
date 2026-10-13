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

const SuiteDoubao = (() => {
    const S = {
        bound: null,              // { taskId, fileKey, rowNum, executionId }
        baselineUrls: [],
        sending: false
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

    /* ---------- 图片采集 ---------- */
    // 仅取"对话区生成结果"类图片，排除头像/图标/表情/上传预览
    function getAllImageUrls() {
        const out = [];
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
            const src = img.currentSrc || img.src || '';
            if (!src || src.startsWith('data:image/svg')) continue;
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w < 120 || h < 120) continue;                       // 头像/图标
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

        const before = getAllImageUrls().length;
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        // 实际等待"上传完成"：预览数量增加，而不是固定等待后假定成功
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            await sleep(500);
            const now = getAllImageUrls().length;
            const previews = document.querySelectorAll('[class*="upload"] img, [class*="preview"] img, [class*="file-item"] img').length;
            if (previews >= files.length || now >= before + files.length) {
                return { ok: true, uploaded: files.length, previews, waitedMs: 60000 - (deadline - Date.now()) };
            }
        }
        throw new Error(`上传未在 60 秒内完成（期望 ${files.length} 张，预览 ${document.querySelectorAll('[class*="upload"] img,[class*="preview"] img').length} 张）`);
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

        // 清空：优先原生 Backspace 逐次删除；失败则直接清空内容
        const existing = readInputText(input);
        if (existing) {
            try {
                for (let i = 0; i < existing.length; i++) await nativeInput('clear');
            } catch (_) {
                if (input.tagName === 'TEXTAREA') input.value = '';
                else input.innerHTML = '';
                input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
        }

        await nativeInput('begin');
        try {
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
        if (got !== want) {
            throw new Error(`提示词输入不完整（期望 ${want.length} 字，实际 ${got.length} 字），已取消发送`);
        }
        return { ok: true, length: got.length };
    }

    /* ---------- 发送（只允许显式调用一次） ---------- */
    async function sendOnce() {
        if (S.sending) throw new Error('已有发送在进行中，拒绝重复发送');
        S.sending = true;
        try {
            const input = findInput();
            if (!input) throw new Error('输入框消失，未发送');
            const before = getAllImageUrls();
            const btn = findSendButton();
            if (btn) {
                btn.click();
            } else {
                // 无可用发送按钮：用原生 Enter 明确提交（这是"发送动作"，不是换行）
                await nativeInput('character', '\r').catch(() => { throw new Error('未找到发送按钮且原生提交失败'); });
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

    /* ---------- 消息入口 ---------- */
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const a = request && request.action;
        if (!a || a.indexOf('suite-') !== 0) return;
        (async () => {
            try {
                if (a === 'suite-probe') { sendResponse(Object.assign({ success: true }, probe())); return; }
                if (a === 'suite-baseline') {
                    S.bound = request.binding || null;
                    S.baselineUrls = getAllImageUrls();
                    sendResponse({ success: true, baselineUrls: S.baselineUrls });
                    return;
                }
                if (a === 'suite-upload') { sendResponse({ success: true, result: await uploadAssets(request.assets) }); return; }
                if (a === 'suite-type') { sendResponse({ success: true, result: await typePrompt(request.text) }); return; }
                if (a === 'suite-send') { sendResponse(Object.assign({ success: true }, await sendOnce())); return; }
                if (a === 'suite-wait') {
                    const r = await waitForNewImages(request.baselineUrls, request.expectCount || 5, request.timeoutMs);
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

    globalThis.SuiteDoubao = { probe, getAllImageUrls, uploadAssets, typePrompt, sendOnce, waitForNewImages, findInput, findSendButton };
    log('套图执行器已注入');
})();
