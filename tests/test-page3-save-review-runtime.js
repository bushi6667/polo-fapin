const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.join(__dirname, '../chrome_extension/content');
function fixture(options = {}) {
    const store = options.store || new Map(), calls = [];
    const product = { row: 2, _publishTaskId: 'task', _publishFileKey: 'file' };
    let active = product, value = options.missing ? '' : 'filled';
    const c = { window: {}, URLSearchParams, location: { search: '?itemId=' + (options.itemId || '123') },
        sessionStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => {
            if (options.storageFails) throw Error('quota'); store.set(k, v);
        } }, setTimeout, clearTimeout };
    c.globalThis = c; c.window = c;
    vm.createContext(c);
    for (const file of ['page3-save-review-cycle.js', 'page3-review.js', 'page3-save-review-runtime.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), c);
    }
    c.PoloPage3Review.checks = () => [
        { label: 'title', action: 'title', read: async () => ({ state: 'pass', detail: 'custom title' }) },
        { label: 'unit', action: 'unit', read: async () => ({ state: options.unknown ? 'unknown' : value ? 'pass' : 'fail', detail: value }) }
    ];
    const read = () => JSON.parse(store.get('polo_save_review::' + JSON.stringify(['task', 'file', 2])) || 'null');
    const write = state => store.set('polo_save_review::' + state.identity, JSON.stringify({ state, itemId: '123' }));
    const state = c.PoloSaveReviewCycle.create(JSON.stringify(['task', 'file', 2]));
    const config = { getProduct: () => active, wait: async () => {}, log: () => {},
        save: async (p, token) => { calls.push(['save', token]); return options.saveFails ? ['⚠️ unconfirmed'] : ['✅ saved']; },
        repair: async (p, action) => { calls.push(['repair', action]); if (!options.repairNoEffect) value = 'repaired'; },
        send: async message => {
            calls.push(['send', message.action]);
            if (options.switchOnRead) active = { ...product };
            if (message.action === 'finishPublishReview') return { ok: !options.finishFails };
            const token = read()?.state;
            return { ok: true, rows: { 2: { itemId: options.evidenceItem || '123', verified: true,
                reviewCycleId: options.oldCycle ? 'old' : token?.cycleId,
                reviewAttempt: options.oldAttempt ? 0 : token?.attempt } } };
        } };
    return { c, product, config, calls, store, read, write, state,
        setValue: next => { value = next; },
        run: extra => c.PoloSaveReviewRuntime.run(product, { ...config, ...extra }) };
}
(async () => {
    let f = fixture();
    assert.equal(await f.run({ resumeOnly: true }), null); assert.equal(f.calls.length, 0);
    f = fixture(); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    assert.equal((await f.run({ resumeOnly: true })).phase, 'complete');
    assert.equal(f.calls.filter(c => c[0] === 'save').length, 0);
    assert.equal(f.calls.filter(c => c[1] === 'finishPublishReview').length, 1);
    assert.equal(f.c.PoloSaveReviewRuntime.proof(f.product).attempt, 1);
    assert.equal(f.c.PoloSaveReviewRuntime.busy, false);
    for (const options of [{ oldCycle: true }, { oldAttempt: true }, { evidenceItem: 'other' }]) {
        f = fixture(options); f.write({ ...f.state, phase: 'saving', attempt: 1 });
        assert.equal((await f.run()).phase, 'blocked');
        assert.equal(f.calls.filter(c => c[0] === 'save' || c[0] === 'repair' || c[1] === 'finishPublishReview').length, 0);
    }
    f = fixture({ missing: true, saveFails: true }); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    assert.equal((await f.run()).phase, 'blocked');
    assert.equal(f.calls.filter(c => c[0] === 'repair').length, 1);
    assert.equal(f.calls.find(c => c[0] === 'repair')[1], 'unit');
    assert.equal(f.calls.filter(c => c[0] === 'save').length, 1);
    assert.equal(f.calls.filter(c => c[1] === 'finishPublishReview').length, 0);
    f = fixture(); assert.equal((await f.run()).phase, 'blocked');
    assert.equal(f.calls.filter(c => c[0] === 'save').length, 1); // 无新文档，不能凭旧DOM判完成。
    f = fixture({ unknown: true }); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    assert.equal((await f.run()).phase, 'blocked'); assert(!f.calls.some(c => c[0] === 'repair'));
    f = fixture({ missing: true, repairNoEffect: true }); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    assert.equal((await f.run()).phase, 'blocked'); assert(!f.calls.some(c => c[0] === 'save'));
    f = fixture({ switchOnRead: true }); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    await assert.rejects(f.run(), /切换/); assert(!f.calls.some(c => c[1] === 'finishPublishReview'));
    f = fixture({ storageFails: true }); await assert.rejects(f.run(), /quota/); assert.equal(f.calls.length, 0);
    f = fixture({ itemId: 'other' }); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    await assert.rejects(f.run(), /身份/); assert.equal(f.calls.length, 0);
    f = fixture({ finishFails: true }); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    await assert.rejects(f.run(), /后台/); assert.equal(f.c.PoloSaveReviewRuntime.busy, false);
    f = fixture(); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    await assert.rejects(f.run({ refreshQuality: async () => { throw Error('质量检测超时'); } }), /质量/);
    assert(!f.calls.some(c => c[1] === 'finishPublishReview'));
    // 检查通过后质量检测仍可能等待；期间出现空缺不得使用旧complete放行。
    f = fixture(); f.write({ ...f.state, phase: 'saving', attempt: 1 });
    let finalHeld = 0;
    await assert.rejects(f.run({ refreshQuality: async () => f.setValue(''),
        hold: async () => { finalHeld++; } }), /最终放行/);
    assert.equal(finalHeld, 1);
    assert.equal(f.read().state.phase, 'reviewing');
    assert(!f.calls.some(c => c[0] === 'save' || c[0] === 'repair' || c[1] === 'finishPublishReview'));
    f = fixture({ missing: true, saveFails: true });
    assert.equal((await f.run()).phase, 'blocked');
    assert.equal(f.calls.filter(c => c[0] === 'repair').length, 1);
    assert.equal(f.calls.find(c => c[0] === 'repair')[1], 'unit');
    f = fixture(); f.write({ ...f.state, phase: 'complete', attempt: 1 });
    await f.run({ startNew: true });
    assert.equal(f.calls.filter(c => c[0] === 'save').length, 1);
    assert.notEqual(f.read().state.cycleId, f.state.cycleId);
    f = fixture(); f.write({ ...f.state, phase: 'blocked', attempt: 1, reason: '未确认' });
    let held = 0;
    assert.equal((await f.run({ startNew: true, hold: async () => { held++; } })).phase, 'blocked');
    assert.equal(held, 1);
    assert.equal(f.calls.length, 0); // 未确认进度不能被“再点一次”清除后重发。
    const page3 = fs.readFileSync(path.join(root, 'page3.js'), 'utf8').split('\n');
    const start = page3.findIndex(line => line.startsWith('async function resumeManualSavedReviewPage3('));
    const end = page3.findIndex((line, index) => index > start && line.trimEnd() === '}');
    assert(start >= 0 && end > start);
    for (const phase of ['complete', 'saving', null]) {
        f = fixture();
        if (phase) f.write({ ...f.state, phase, attempt: 1 });
        const resumed = [];
        Object.assign(f.c, { currentProduct: f.product, sleep3: async () => {},
            ensureTabActive: async () => { resumed.push('active'); },
            waitPublishFormReady: async () => { resumed.push('ready'); return true; },
            runSavedReviewPage3: async (p, options) => { assert.equal(options.resumeOnly, true); resumed.push('resume'); },
            log: message => { throw Error(message); } });
        vm.runInContext(page3.slice(start, end + 1).join('\n'), f.c);
        await vm.runInContext('resumeManualSavedReviewPage3()', f.c);
        assert.deepEqual(resumed, phase === 'saving' ? ['active', 'ready', 'resume'] : []);
    }
    console.log('PASS real runtime/controller/review-run: reload recovery, scoped repair, stale evidence, no duplicate save and storage/identity guards');
})().catch(e => { console.error(e); process.exitCode = 1; });
