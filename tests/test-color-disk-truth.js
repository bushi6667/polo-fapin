// ============================================================
// 颜色图「磁盘是唯一真相」页面行为测试
// 被测：发品助手.html 的 loadColorImagesFromExtension（真实抽取）
// 覆盖：
//   ① 路径模式：本地探测失败 + 扩展只给缓存(fromDisk:false) → 清空，且【不】弹授权提示
//   ② 令牌模式：扩展真读盘(fromDisk:true) → 正常显示
//   ③ 令牌模式：扩展只给缓存(fromDisk:false) → 清空 + 弹一次授权提示
//   ④ 令牌模式：扩展报权限错误(ok:false, error 含"重新授权") → 清空 + 提示
// 运行：node tests/test-color-disk-truth.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');
let pass = 0, fail = 0;
const failures = [];
function ok(c, n, e) { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' :: ' + e : ''}`); } }

function extractFn(name) {
    const lines = HTML.split('\n').map(l => l.replace(/\r$/, ''));
    const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    let s = -1; for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { s = i; break; } }
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) { if (lines[j] === '}') return lines.slice(s, j + 1).join('\n'); }
    throw new Error('函数未闭合: ' + name);
}

function el(tag = 'div') {
    const e = {
        tagName: tag.toUpperCase(), className: '', innerHTML: '', textContent: '', style: {}, children: [], _classes: new Set(), attrs: {},
        classList: { add: c => e._classes.add(c), remove: c => e._classes.delete(c), contains: c => e._classes.has(c) },
        querySelector(sel) { return q(sel)[0] || null; },
        querySelectorAll(sel) { return q(sel); },
        appendChild(c) { c.parent = e; e.children.push(c); return c; },
        insertBefore(c) { c.parent = e; e.children.unshift(c); return c; },
        remove() { if (e.parent) e.parent.children = e.parent.children.filter(x => x !== e); },
        addEventListener() {}
    };
    function q(sel) {
        const out = [];
        const walk = (n) => {
            let m = sel.match(/^\[data-color="(.+)"\]$/);
            if (m && n.attrs['data-color'] === m[1]) out.push(n);
            m = sel.match(/^([a-z]+)$/i);
            if (m && n.tagName === m[1].toUpperCase()) out.push(n);
            m = sel.match(/^\.([a-z-]+)$/);
            if (m && n._classes.has(m[1])) out.push(n);
            for (const c of n.children) walk(c);
        };
        walk(e);
        return out;
    }
    return e;
}

function makeEnv({ mode, localPath, resp }) {
    // DOM：4 个颜色格子
    const grid = el();
    for (const c of ['white', 'black', 'gray', 'navy']) {
        const it = el(); it.attrs['data-color'] = c;
        const name = el(); name._classes.add('color-name'); it.appendChild(name);
        grid.appendChild(it);
    }
    const byId = { colorImagesGrid: grid, colorImagesSection: el() };
    const toasts = [];
    // Image mock：设置 src 立即触发 onerror（模拟本地文件不存在）
    class FakeImage {
        set src(v) { this._src = v; setTimeout(() => { if (this.onerror) this.onerror(); }, 0); }
        get src() { return this._src; }
    }
    const sent = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
        window: {},
        document: {
            getElementById: id => byId[id] || null,
            querySelector: () => null,
            createElement: t => el(t),
            addEventListener: () => {}
        },
        Image: FakeImage,
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        products: [{ row: 2 }], currentProduct: { row: 2 }, currentRowIndex: 0,
        loadedFileName: 'A.xlsx', currentFileKey: () => 'A__',
        extensionInstalled: true, EXTENSION_ID: 'x',
        colorImgBaseDir: mode === 'token' ? 'polo-dir:abc' : (mode === 'path' ? 'C:\\Users\\王同学\\Downloads\\Polo发品_颜色图' : ''),
        getColorImagePath: () => localPath,
        showToast: m => toasts.push(m),
        chrome: { runtime: {
            lastError: null,
            sendMessage: (id, req, cb) => { sent.push(req); setTimeout(() => cb(resp), 0); }
        } },
        colorDirUnauthorizedNoted: false,
        setTimeout, clearTimeout, Promise, JSON, Number, Array, Object, String, Math, Date, RegExp, Set, Map, Error
    };
    sandbox.globalThis = sandbox;
    const cx = vm.createContext(sandbox);
    vm.runInContext([
        extractFn('loadColorImagesFromExtension'),
        extractFn('clearColorImage'),
        extractFn('setColorImage'),
        extractFn('noteColorDirUnauthorized'),
        extractFn('showColorDirFixButton'),
        extractFn('clearColorDirFixButton')
    ].join('\n\n'), cx, { filename: 'page:color' });
    return { cx, grid, toasts, sent, sandbox };
}

const itemOf = (grid, c) => grid.children.find(x => x.attrs['data-color'] === c);

(async function main() {
    console.log('=== 颜色图磁盘真相 测试 ===\n');

    console.log('【①】路径模式：本地失败 + 仅缓存 → 清空且不提示授权');
    {
        const env = makeEnv({ mode: 'path', localPath: 'file:///C:/x/row2_white.png', resp: { ok: true, fromDisk: false, dataUrl: 'data:image/png;base64,AAA' } });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 60));
        const w = itemOf(env.grid, 'white');
        ok(!w.children.some(c => c.tagName === 'IMG'), '未显示缓存图（无 img）');
        ok(w._classes.has('missing'), '标记为 missing');
        ok(env.toasts.length === 0, `路径模式不误报授权（toast=${env.toasts.length}）`);
    }

    console.log('\n【②】令牌模式：扩展真读盘 → 正常显示');
    {
        const env = makeEnv({ mode: 'token', localPath: null, resp: { ok: true, fromDisk: true, dataUrl: 'data:image/png;base64,BBB' } });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 60));
        const w = itemOf(env.grid, 'white');
        ok(w.children.some(c => c.tagName === 'IMG'), '显示真实磁盘图');
        ok(!w._classes.has('missing'), '不标记 missing');
        ok(env.toasts.length === 0, '无授权提示');
    }

    console.log('\n【③】令牌模式：扩展只给缓存 → 清空 + 单次授权提示');
    {
        const env = makeEnv({ mode: 'token', localPath: null, resp: { ok: true, fromDisk: false, dataUrl: 'data:image/png;base64,CCC' } });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 80));
        const w = itemOf(env.grid, 'white');
        ok(!w.children.some(c => c.tagName === 'IMG'), '缓存图不显示（删了就该消失）');
        ok(env.toasts.some(t => /重新授权/.test(t)), '提示重新授权（不是静默当成删除）');
        const n = env.toasts.length;
        ok(n === 1, `整页只提示一次（实际 ${n} 次，4 张图共享）`);
    }

    console.log('\n【④】令牌模式：扩展报权限错误 ok:false → 清空 + 提示');
    {
        const env = makeEnv({ mode: 'token', localPath: null, resp: { ok: false, error: '颜色图目录需要重新授权' } });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 60));
        const w = itemOf(env.grid, 'white');
        ok(!w.children.some(c => c.tagName === 'IMG'), '不显示');
        ok(env.toasts.some(t => /重新授权/.test(t)), '权限失败也提示重新授权（不被当作普通删除）');
    }

    console.log('\n' + '='.repeat(54));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(54));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
