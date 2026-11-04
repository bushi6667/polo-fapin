const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(__dirname + '/../chrome_extension/upload/save-evidence.js', 'utf8');
const store = new Map(), url = 'https://post.alibaba.com/product/publish.htm?itemId=123&pubAction=draft';
const c = { URL, Date, location: { href: url }, performance: { timeOrigin: 200 },
    sessionStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) } };
vm.createContext(c); vm.runInContext(source, c);
const now = Date.now();
const args = { verdict: { verified: false, failure: false, signals: [] }, beforeUrl: url, nowUrl: url,
    token: 'attempt', startedAt: now - 100, captured: { href: url, doc: 200,
        saved: { token: 'attempt', href: url, doc: 100, at: now, success: true, error: false, signals: ['dialogOk:保存成功'] } } };
assert.equal(c.PoloSaveEvidence.recover(args).verified, true);
for (const patch of [{ token: 'old' }, { at: now - 1000 }, { href: url + '&other' }, { doc: NaN }, { success: false }]) {
    const result = c.PoloSaveEvidence.recover({ ...args, captured: { ...args.captured, saved: { ...args.captured.saved, ...patch } } });
    assert.equal(result.verified, false);
}
assert.equal(c.PoloSaveEvidence.recover({ ...args, captured: { ...args.captured, doc: 100 } }).verified, false);
assert.equal(c.PoloSaveEvidence.recover({ ...args, captured: null }).verified, false);
assert.equal(c.PoloSaveEvidence.recover({ ...args, verdict: { verified: true, signals: [] },
    captured: { ...args.captured, saved: { ...args.captured.saved, error: true } } }).failure, true);
for (const target of ['https://login.alibaba.com/', 'https://post.alibaba.com/product/publish.htm?error=1',
    'https://example.com/product/publish.htm?itemId=123', 'https://post.alibaba.com/product/publish.htm?itemId=999']) {
    assert.equal(c.PoloSaveEvidence.recover({ ...args, nowUrl: target }).verified, false);
}
const fresh = { ...args, beforeUrl: 'https://post.alibaba.com/product/publish.htm?cacheId=first', captured: null };
assert.equal(c.PoloSaveEvidence.recover(fresh).verified, true);
assert.equal(c.PoloSaveEvidence.recover({ ...fresh, verdict: { failure: true, signals: [] } }).failure, true);
store.set('polo_save_probe::attempt', JSON.stringify(args.captured.saved));
assert.equal(c.PoloSaveEvidence.read('attempt').saved.token, 'attempt');
assert.equal(store.size, 0);
store.set('polo_save_probe::bad', '{broken');
assert.equal(c.PoloSaveEvidence.read('bad'), null); assert.equal(store.size, 0);

// 执行真实探针，证明确切成功/错误能在页面被销毁前留下本次凭据。
const bg = fs.readFileSync(__dirname + '/../chrome_extension/background.js', 'utf8').split('\n');
const start = bg.findIndex(l => l.startsWith('async function saveVerifyProbe('));
const end = bg.findIndex((l, i) => i > start && l.trimEnd() === '}');
let message = '保存成功，3秒后自动刷新';
const dialog = { innerText: '', getBoundingClientRect: () => ({ width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }), parentElement: null };
Object.defineProperty(dialog, 'innerText', { get: () => message });
Object.assign(c, { setTimeout, window: { innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    document: { querySelectorAll: s => s.includes('.next-dialog') ? [dialog] : [] } });
vm.runInContext(bg.slice(start, end + 1).join('\n'), c);
(async () => {
    await c.saveVerifyProbe(0, 'capture');
    let proof = JSON.parse(store.get('polo_save_probe::capture'));
    assert.equal(proof.success, true); assert.equal(proof.token, 'capture'); assert.equal(proof.doc, 200);
    message = '保存失败'; await c.saveVerifyProbe(0, 'capture');
    proof = JSON.parse(store.get('polo_save_probe::capture')); assert.equal(proof.error, true);
    // Chrome可能先返回空探针，下一次脚本仍命中旧文档；须保留证据并等新文档提交。
    for (const name of ['decideSaveVerification', 'verifyPublishSaved']) {
        const first = bg.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
        const last = bg.findIndex((l, i) => i > first && l.trimEnd() === '}');
        vm.runInContext(bg.slice(first, last + 1).join('\n'), c);
    }
    let reads = 0, probes = 0, waits = 0;
    Object.assign(c, { SAVE_VERIFY_WAIT_MS: 8000, readTabUrl: async () => url, appendPublishLog: async () => {},
        setTimeout: fn => { waits++; fn(); }, chrome: { scripting: { executeScript: async ({ func, args }) => {
            if (func.name === 'saveVerifyProbe') { probes++; return []; }
            reads++;
            return [{ result: { href: url, doc: reads === 1 ? 100 : 200,
                saved: reads === 1 ? { token: args[0], href: url, doc: 100, at: Date.now(), success: true,
                    signals: ['dialogOk:保存成功'] } : null } }];
        } } } });
    const verified = await c.verifyPublishSaved(1, url);
    assert.equal(verified.verified, true); assert.equal(reads, 2); assert.equal(probes, 1); assert.equal(waits, 1);
    // 真机导航间隙第一次读取直接抛错/无frame结果，不能把它误当永久存储不可用而提前退出。
    for (const mode of ['throw', 'empty']) {
        reads = 0; probes = 0; waits = 0;
        c.chrome.scripting.executeScript = async ({ func, args }) => {
            if (func.name === 'saveVerifyProbe') { probes++; return []; }
            reads++;
            if (reads === 1) {
                if (mode === 'throw') throw Error('Frame is navigating');
                return [];
            }
            return [{ result: { href: url, doc: 200, saved: { token: args[0], href: url, doc: 100,
                at: Date.now(), success: true, signals: ['dialogOk:保存成功'] } } }];
        };
        assert.equal((await c.verifyPublishSaved(1, url)).verified, true);
        assert.equal(reads, 2); assert.equal(probes, 1); assert.equal(waits, 1);
    }
    console.log('PASS save evidence: empty-result new draft, same-URL reload with fresh captured success, stale/wrong item/login/error rejection, error priority, capture and cleanup');
})().catch(e => { console.error(e); process.exitCode = 1; });
