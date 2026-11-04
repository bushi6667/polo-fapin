/* 保留本次保存探针已观察到的信号，避免页面重载销毁Promise后丢失成功证据。 */
(() => {
    'use strict';
    function readSaveProbeEvidence(token) {
        const key = 'polo_save_probe::' + token;
        try {
            const raw = sessionStorage.getItem(key);
            sessionStorage.removeItem(key);
            return { saved: raw ? JSON.parse(raw) : null, href: location.href, doc: performance.timeOrigin };
        } catch (_) { return null; }
    }
    function recover({ verdict, captured, beforeUrl, nowUrl, token, startedAt }) {
        const signals = [...(verdict.signals || [])];
        const proof = captured?.saved;
        const matched = proof && proof.token === token && proof.href === beforeUrl
            && Number.isFinite(proof.at) && proof.at >= startedAt && proof.at <= Date.now()
            && Number.isFinite(proof.doc);
        if (verdict.failure || matched && proof.error) {
            return { verified: false, failure: true, signals: [...signals, ...(matched ? proof.signals || [] : [])].slice(0, 12) };
        }
        if (verdict.verified) return verdict;
        let destination = false;
        try {
            const page = new URL(nowUrl), before = new URL(beforeUrl);
            const id = page.searchParams.get('itemId') || '', previous = before.searchParams.get('itemId');
            destination = page.origin === 'https://post.alibaba.com'
                && (page.pathname === '/product/publish/success'
                    || page.pathname === '/product/publish.htm' && /^\d+$/.test(id) && (!previous || previous === id));
        } catch (_) {}
        if (beforeUrl && nowUrl !== beforeUrl && destination) {
            return { verified: true, failure: false, signals: [...signals, 'savedDestination:' + nowUrl.slice(0, 100)] };
        }
        if (matched && proof.success && destination && captured.href === nowUrl
            && Number.isFinite(captured.doc) && captured.doc !== proof.doc) {
            return { verified: true, failure: false, signals: [...signals, ...proof.signals || [], 'probe:success-before-reload'] };
        }
        return { ...verdict, signals: [...signals, 'probe:no-confirmed-saved-destination'] };
    }
    globalThis.PoloSaveEvidence = { read: readSaveProbeEvidence, recover };
})();
