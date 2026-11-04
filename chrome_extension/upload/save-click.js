/* 保存专用：鼠标指令成功不等于按钮收到点击。只在确证未触发时补救一次。 */
(() => {
    'use strict';
    // executeScript序列化入口，不依赖本文件闭包。
    async function saveClickPage(mode, token) {
        const key = '__poloSaveClickProof';
        const text = e => String(e?.innerText || e?.textContent || '').trim();
        const isSave = e => e && text(e) === '保存' && !e.closest('#polo-helper-panel');
        if (mode === 'arm') {
            if (window[key]) return { ok: false, error: '已有保存点击观察，停止并发保存' };
            const state = { token, href: location.href, clicks: 0, presses: 0 };
            state.listener = event => {
                if (!isSave(event.target?.closest?.('button'))) return;
                if (event.type === 'click') state.clicks++;
                else state.presses++;
            };
            document.addEventListener('click', state.listener, true);
            document.addEventListener('mousedown', state.listener, true);
            window[key] = state;
        }
        const state = window[key];
        if (!state || state.token !== token) return { ok: false, error: '保存点击观察已变化，不能补点' };
        if (mode === 'cleanup') {
            document.removeEventListener('click', state.listener, true);
            document.removeEventListener('mousedown', state.listener, true);
            delete window[key];
            return { ok: true };
        }
        if (state.href !== location.href) return { ok: false, error: '保存页面已变化，不能补点' };
        if (mode === 'target' || mode === 'fallback') {
            if (state.clicks || state.presses) return { ok: false, error: '保存已经触发，不能再次点击' };
            const buttons = [...document.querySelectorAll('button')].filter(e => {
                const r = e.getBoundingClientRect();
                return isSave(e) && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
            });
            if (buttons.length !== 1 || buttons[0].disabled) return { ok: false, error: '保存按钮不唯一、未就绪或已禁用' };
            const button = buttons[0];
            button.scrollIntoView({ block: 'center' });
            const r = button.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
            if (document.elementFromPoint(x, y)?.closest('button') !== button) return { ok: false, error: '保存按钮被遮挡，不点击其他位置' };
            if (mode === 'fallback') button.click();
            return { ok: true, x, y, clicks: state.clicks, presses: state.presses };
        }
        return { ok: true, clicks: state.clicks, presses: state.presses };
    }
    async function click(adapter) {
        const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        let attempted = false;
        try {
            const armed = await adapter.page('arm', token);
            if (!armed?.ok) return { ok: false, error: armed?.error || '无法观察保存点击' };
            const mouse = await adapter.mouse(async () => adapter.page('target', token));
            attempted = !!(mouse?.ok || mouse?.dispatched);
            await adapter.wait(150);
            const proof = await adapter.page('read', token);
            if (!proof?.ok) return { ok: false, attempted, unconfirmed: true, error: proof?.error || '保存点击证据丢失，不补点' };
            if (proof.clicks > 0) return { ok: true, received: true, method: 'mouse' };
            if (proof.presses > 0 || mouse?.dispatched && !mouse.ok) {
                return { ok: false, attempted, unconfirmed: true, error: '保存鼠标动作已开始但点击未确认，不重复保存' };
            }
            // 没有保存按下/点击证据才允许补救；重新检查同页、按钮身份和遮挡。
            const fallback = await adapter.page('fallback', token);
            return fallback?.ok && fallback.clicks > 0
                ? { ok: true, received: true, method: 'button-fallback' }
                : { ok: false, error: fallback?.error || '保存按钮未收到点击，补救未生效' };
        } catch (error) {
            return { ok: false, attempted, unconfirmed: true, error: error.message || '保存点击状态未知，不重试' };
        } finally {
            try { await adapter.page('cleanup', token); } catch (_) {}
        }
    }
    globalThis.PoloSaveClick = { page: saveClickPage, click };
})();
