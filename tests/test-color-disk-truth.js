// ============================================================
// 颜色图读取链路测试（路径模式：本地服务读盘）
// 被测：发品助手.html 的 loadColorImagesFromExtension（真实抽取）
// 契约（路径模式改造后）：
//   ① 已配置目录 + 服务可用 + 图片存在 → 用 http://127.0.0.1:8765/local-image?path=… 显示
//   ② 已配置 + 服务未启动 → 清空并提示，不回退 file://、不出现「授权失效」
//   ③ 已配置 + 文件不存在 → 清空（删除即消失），日志说明是磁盘缺失
//   ④ 未配置路径 → 不显示缓存图，提示去「路径配置」
// 运行：node tests/test-color-disk-truth.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '发品助手.html'), 'utf8');
let pass = 0, fail = 0; const failures = [];
function ok(c, n, e) { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n); console.log('  ❌ ' + n + (e ? ' :: ' + e : '')); } }

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
        querySelector(sel) { return q(sel)[0] || null; }, querySelectorAll(sel) { return q(sel); },
        appendChild(c) { c.parent = e; e.children.push(c); return c; },
        insertBefore(c) { c.parent = e; e.children.unshift(c); return c; },
        remove() { if (e.parent) e.parent.children = e.parent.children.filter(x => x !== e); },
        addEventListener() {}, setAttribute() {}
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
        walk(e); return out;
    }
    return e;
}

function makeEnv({ cfgColorDir, serverUp, httpStatus }) {
    const grid = el(); grid.attrs.id = 'colorImagesGrid';
    for (const c of ['white', 'black', 'gray', 'navy']) {
        const it = el(); it.attrs['data-color'] = c;
        const name = el(); name._classes.add('color-name'); it.appendChild(name);
        grid.appendChild(it);
    }
    const byId = { colorImagesGrid: grid, colorImagesSection: el(), suiteImagesGrid: el(), suiteImagesArea: el() };
    const toasts = [], logs = [];
    // fetch 桩：按 httpStatus 返回 200/403/404；serverUp=false 时直接拒绝（模拟连接失败）
    const fetchCalls = [];
    const fakeFetch = (url) => {
        fetchCalls.push(url);
        if (!serverUp) return Promise.reject(new Error('failed to fetch'));
        const status = httpStatus === undefined ? 404 : httpStatus;
        return Promise.resolve({
            status,
            blob: () => Promise.resolve({ size: status === 200 ? 3 : 0, type: 'image/png' })
        });
    };
    class FakeImage { set src(v) { this._src = v; } get src() { return this._src; } }
    const PathConfig = {
        read: () => ({ colorImgDir: cfgColorDir || '', imageDir: '', scriptDir: '', suiteDir: '' }),
        serverState: () => (serverUp ? 'up' : 'down'),
        serverUp: () => !!serverUp,
        pingServer: () => Promise.resolve(serverUp ? 'up' : 'down'),
        imageUrl: (abs, bust) => 'http://127.0.0.1:8765/local-image?path=' + encodeURIComponent(abs) + (bust ? '&v=' + Date.now() : ''),
        colorImagePath: (row, color, folder) => cfgColorDir ? cfgColorDir + '\\' + folder + '\\row' + row + '\\row' + row + '_' + color + '.png' : '',
        open: () => {}
    };
    const sandbox = {
        console: { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {}, info: (...a) => logs.push(a.join(' ')), debug() {} },
        document: { getElementById: id => byId[id] || null, querySelector: () => null, querySelectorAll: () => [], createElement: t => el(t), addEventListener() {} },
        Image: FakeImage, fetch: fakeFetch, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        products: [{ row: 2 }], currentProduct: { row: 2 }, loadedFileName: 'A.xlsx',
        currentFileKey: () => 'A__', extensionInstalled: true, EXTENSION_ID: 'x',
        getColorImagePath: () => '',
        showToast: m => toasts.push(m),
        chrome: { runtime: { lastError: null, sendMessage: (id, req, cb) => setTimeout(() => cb({ ok: false, error: '无' }), 0) } },
        setTimeout, clearTimeout, Promise, JSON, Number, Array, Object, String, Math, Date, RegExp, Set, Map, Error,
        colorServerDownNoted: false, colorPathMissingNoted: false, colorFileMissingNoted: '', colorDirUnauthorizedNoted: false, colorLogStamp: ''
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window.PathConfig = PathConfig;
    sandbox.PathConfig = PathConfig;
    const cx = vm.createContext(sandbox);
    vm.runInContext([
        extractFn('loadColorImagesFromExtension'),
        extractFn('clearColorImage'),
        extractFn('setColorImage'),
        extractFn('noteColorServerDown'),
        extractFn('noteColorPathMissing'),
        extractFn('noteColorFetchError'),
        extractFn('noteColorDirUnauthorized'),
        extractFn('showColorDirFixButton'),
        extractFn('clearColorDirFixButton')
    ].join('\n\n'), cx, { filename: 'page:color' });
    return { cx, grid, toasts, logs, fetchCalls };
}

const itemOf = (grid, c) => grid.children.find(x => x.attrs['data-color'] === c);
const imgOf = (grid, c) => { const it = itemOf(grid, c); return it && it.children.find(x => x.tagName === 'IMG'); };

(async function main() {
    console.log('=== 颜色图读取链路（路径模式）测试 ===\n');

    console.log('【①】已配置目录 + 服务可用 + 图片存在 → 本地服务 URL 显示');
    {
        const env = makeEnv({ cfgColorDir: 'C:\\Users\\wangs\\Downloads\\Polo发品_颜色图', serverUp: true, imageLoads: true });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 80));
        ok(env.fetchCalls.length === 4, '四种颜色各发起一次读图请求', env.fetchCalls.length);
        const u = decodeURIComponent(env.fetchCalls[0] || '');
        ok(u.startsWith('http://127.0.0.1:8765/local-image?path='), '图片经本地服务读取（不是 file://）', u);
        ok(/row2_white\.png/.test(u), '路径按 <目录>/<文件名>/row2/row2_white.png 拼接', u);
        ok(/[&?]v=\d+/.test(env.fetchCalls[0] || ''), '带时间戳参数（删文件立即反映）');
    }

    console.log('\n【②】服务未启动 → 清空并提示，不回退 file://');
    {
        const env = makeEnv({ cfgColorDir: 'C:\\Users\\wangs\\Downloads\\Polo发品_颜色图', serverUp: false, imageLoads: true });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 60));
        ok(env.fetchCalls.length === 0, '服务未启动时不发起读图请求');
        ok(env.toasts.some(t => /本地服务未启动/.test(t)), '提示本地服务未启动', JSON.stringify(env.toasts));
        ok(!env.toasts.some(t => /授权/.test(t)), '不再出现「授权失效」');
    }

    console.log('\n【③】文件不存在 → 清空（删除即消失）');
    {
        const env = makeEnv({ cfgColorDir: 'C:\\Users\\wangs\\Downloads\\Polo发品_颜色图', serverUp: true, imageLoads: false });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 80));
        ok(env.fetchCalls.length === 4, '仍然按路径去请求（404 由服务端如实返回）');
        ok(env.toasts.length > 0, '404 有明确提示（不静默）', JSON.stringify(env.toasts));
    }

    console.log('\n【④】未配置路径 → 不显示缓存图');
    {
        const env = makeEnv({ cfgColorDir: '', serverUp: true, httpStatus: 200 });
        vm.runInContext('loadColorImagesFromExtension(2)', env.cx);
        await new Promise(r => setTimeout(r, 80));
        ok(env.fetchCalls.length === 0, '未配置路径时不请求、也不显示缓存图');
        ok(env.toasts.every(t => !/授权/.test(t)), '不出现「授权失效」');
    }

    console.log('\n' + '='.repeat(54));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(54));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
