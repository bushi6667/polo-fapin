const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(__dirname + '/../chrome_extension/upload/save-click.js', 'utf8');
function fixture(options = {}) {
    const listeners = {}, events = [];
    let r = { left: 50, top: 600, width: 100, height: 40 };
    const button = { innerText: '保存', disabled: false,
        closest: s => s === 'button' ? button : null,
        getBoundingClientRect: () => r, scrollIntoView() {},
        click() { events.push('click'); for (const f of listeners.click || []) f({ type: 'click', target: button }); }
    };
    const c = { window: {}, location: { href: 'https://post.alibaba.com/product/publish.htm' },
        getComputedStyle: () => ({ visibility: 'visible' }),
        document: { querySelectorAll: () => [button],
            elementFromPoint: () => options.covered ? { closest: () => null } : button,
            addEventListener: (type, f) => (listeners[type] ||= []).push(f),
            removeEventListener: (type, f) => { listeners[type] = listeners[type].filter(x => x !== f); } }
    };
    c.globalThis = c; vm.createContext(c); vm.runInContext(source, c);
    const modes = [];
    const adapter = {
        page: async (mode, token) => { modes.push(mode); return c.PoloSaveClick.page(mode, token); },
        mouse: async resolve => {
            // 调试连接/视口变化后才解析坐标，不用调用方提供的旧位置。
            r = { ...r, top: 560 };
            const target = await resolve(); events.push(['target', target.y]);
            if (!target.ok) return target;
            if (options.navigate) { c.location.href += '?new'; return { ok: false, dispatched: true }; }
            if (options.pressOnly) {
                for (const f of listeners.mousedown || []) f({ type: 'mousedown', target: button });
                return { ok: false, dispatched: true };
            }
            if (options.failAfterDispatch) return { ok: false, dispatched: true };
            if (!options.miss) button.click();
            return { ok: true };
        }, wait: async () => {}
    };
    return { c, button, modes, events, adapter, run: () => c.PoloSaveClick.click(adapter) };
}
(async () => {
    let f = fixture(), result = await f.run();
    assert.equal(result.method, 'mouse'); assert.equal(f.events.filter(e => e === 'click').length, 1);
    assert.equal(f.events[0][1], 580); assert(!f.modes.includes('fallback'));
    assert.equal(f.c.window.__poloSaveClickProof, undefined);
    f = fixture({ miss: true }); result = await f.run();
    assert.equal(result.method, 'button-fallback');
    assert.equal(f.modes.filter(m => m === 'fallback').length, 1);
    assert.equal(f.events.filter(e => e === 'click').length, 1);
    for (const options of [{ pressOnly: true }, { failAfterDispatch: true }, { navigate: true }]) {
        f = fixture(options); result = await f.run();
        assert.equal(result.ok, false); assert.equal(result.unconfirmed, true);
        assert.equal(result.attempted, true);
        assert(!f.modes.includes('fallback')); assert(!f.events.includes('click'));
        assert.equal(f.c.window.__poloSaveClickProof, undefined);
    }
    f = fixture({ covered: true }); result = await f.run();
    assert.equal(result.ok, false); assert.match(result.error, /遮挡/); assert(!f.events.includes('click'));
    f = fixture(); f.button.disabled = true; result = await f.run();
    assert.equal(result.ok, false); assert(!f.events.includes('click'));
    f = fixture();
    await f.c.PoloSaveClick.page('arm', 'owner'); result = await f.run();
    assert.equal(result.ok, false); assert.equal(f.c.window.__poloSaveClickProof.token, 'owner');
    await f.c.PoloSaveClick.page('cleanup', 'owner');
    f = fixture(); f.adapter.page = async () => { throw Error('context lost'); };
    result = await f.run(); assert.equal(result.unconfirmed, true); assert(!f.events.includes('click'));

    // 验证真实后台鼠标函数的连接顺序，不用另写一套鼠标逻辑。
    const bg = fs.readFileSync(__dirname + '/../chrome_extension/background.js', 'utf8');
    const lines = bg.split('\n'), start = lines.findIndex(l => l.startsWith('async function realClickCDP('));
    const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
    const calls = [];
    const c = { chrome: { debugger: { attach: async () => calls.push('attach'), detach: async () => calls.push('detach'),
        sendCommand: async (_, method, p) => calls.push([p.type, p.x, p.y]) } }, setTimeout: fn => { fn(); } };
    vm.createContext(c); vm.runInContext(lines.slice(start, end + 1).join('\n'), c);
    result = await c.realClickCDP(1, 999, 999, async () => { calls.push('resolve'); return { ok: true, x: 10, y: 20 }; });
    assert.equal(result.ok, true); assert.equal(calls[0], 'attach'); assert.equal(calls[1], 'resolve');
    assert(calls.filter(Array.isArray).every(e => e[1] === 10 && e[2] === 20));
    calls.length = 0;
    result = await c.realClickCDP(1, 999, 999, async () => ({ ok: false, error: 'covered' }));
    assert.equal(result.ok, false); assert(!calls.some(Array.isArray)); assert.equal(calls.at(-1), 'detach');
    console.log('PASS save click: fresh coordinates after attach, received-event evidence, one safe fallback, no replay after press/error/navigation, blocked/concurrent targets, cleanup');
})().catch(e => { console.error(e); process.exitCode = 1; });
