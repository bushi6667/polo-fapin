// ============================================================
// 路径配置 + 本地服务读图 测试（真实起服务，不打桩）
// 覆盖验收项：完整路径保存/刷新、空格中文连字符、polo-dir 拒绝、读真实图片、
//            路径穿越拒绝、非图片拒绝、文件不存在 404、配置持久化
// 运行：node tests/test-path-config-server.js
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, '_path_config.json');
const TMP = path.join(ROOT, '_tmp_pathcfg');
const PORT = 8799;                 // 测试用独立端口，避免撞上正在运行的生产服务
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0; const failures = [];
function ok(c, n, extra) { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n); console.log('  ❌ ' + n + (extra ? ' :: ' + extra : '')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makePng() {
    // 1x1 透明 PNG
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
}

async function waitUp(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const r = await fetch(BASE + '/path-config'); if (r.ok) return true; } catch (_) {}
        await sleep(150);
    }
    return false;
}

(async function main() {
    console.log('=== 路径配置 / 本地服务 测试 ===\n');
    const cfgBackup = fs.existsSync(CFG) ? fs.readFileSync(CFG) : null;
    let server = null;
    try {
        // 准备：临时目录含中文、空格、连字符 + 一张真实 PNG + 一个非图片文件
        const dir = path.join(TMP, 'Polo发品_颜色图 测试-v1', 'row1');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'row1_white.png'), makePng());
        fs.writeFileSync(path.join(dir, 'not-image.js'), 'console.log(1)');

        // 起真实服务
        server = spawn(process.execPath, [path.join(ROOT, '_server.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, POLO_PORT: String(PORT) } });
        const up = await waitUp(8000);
        ok(up, '本地服务可在 127.0.0.1:' + PORT + ' 启动');
        if (!up) throw new Error('服务未就绪');

        // ---------- ① 保存完整中文/空格/连字符绝对路径 ----------
        console.log('\n【①】保存完整路径（中文 + 空格 + 连字符）');
        const colorDir = path.join(TMP, 'Polo发品_颜色图 测试-v1');
        const post = await fetch(BASE + '/path-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ colorImgDir: colorDir + path.sep })
        }).then(r => r.json());
        ok(post.ok === true, 'POST /path-config 返回 ok');
        ok(post.items[0].status === 'ok', '目录存在 → status=ok', JSON.stringify(post.items[0]));
        const norm = v => String(v || '').replace(/[\/]+$/, '');
        ok(norm(post.config.colorImgDir) === norm(colorDir), '末尾斜杠已归一化且未改动中文/空格/连字符', post.config.colorImgDir);
        const persisted = JSON.parse(fs.readFileSync(CFG, 'utf8'));
        ok(norm(persisted.colorImgDir) === norm(colorDir), '配置已落盘（刷新后可恢复）', persisted.colorImgDir);

        // ---------- ② 读取真实图片 ----------
        console.log('\n【②】按绝对路径读取磁盘图片');
        const imgUrl = BASE + '/local-image?path=' + encodeURIComponent(path.join(dir, 'row1_white.png'));
        const ir = await fetch(imgUrl);
        const buf = Buffer.from(await ir.arrayBuffer());
        ok(ir.status === 200, '存在的图片 → 200');
        ok((ir.headers.get('content-type') || '').includes('image/png'), 'Content-Type 为 image/png');
        ok(buf.length > 0 && buf[0] === 0x89, '返回的是真实 PNG 字节');
        ok(ir.headers.get('cache-control') === 'no-store', '不缓存（删文件后立刻反映）');

        // ---------- ③ 文件不存在 → 404 中文业务错误 ----------
        console.log('\n【③】文件不存在');
        const miss = await fetch(BASE + '/local-image?path=' + encodeURIComponent(path.join(dir, 'row1_white_deleted.png')));
        const missJson = await miss.json().catch(() => ({}));
        ok(miss.status === 404, '缺失文件 → 404');
        ok(/文件不存在/.test(missJson.error || ''), '返回中文业务错误', JSON.stringify(missJson));

        // ---------- ④ 路径穿越拒绝 ----------
        console.log('\n【④】路径穿越');
        const trav1 = await fetch(BASE + '/local-image?path=' + encodeURIComponent(path.join(dir, '..', '..', '..', '_server.js')));
        ok(trav1.status === 403, '../../.. 穿越 → 403');
        const trav2 = await fetch(BASE + '/local-image?path=' + encodeURIComponent(path.join(TMP, 'Polo发品_颜色图 测试-v1', 'row1', '..', '..', '..', 'x.png')));
        ok(trav2.status === 403, '含 .. 的路径 → 403');

        // ---------- ⑤ 非图片 / 敏感文件拒绝 ----------
        console.log('\n【⑤】非图片与敏感文件');
        const js = await fetch(BASE + '/local-image?path=' + encodeURIComponent(path.join(dir, 'not-image.js')));
        ok(js.status === 403, '目录内 .js 文件 → 403（只允许图片扩展名）');
        const cfgFile = await fetch(BASE + '/local-image?path=' + encodeURIComponent(path.join(ROOT, 'chrome_extension', 'js代码', 'api_config.json')));
        ok(cfgFile.status === 403, 'api_config.json → 403');

        // ---------- ⑥ polo-dir 令牌与相对路径 ----------
        console.log('\n【⑥】polo-dir 令牌 / 相对路径');
        const tok = await fetch(BASE + '/path-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageDir: 'polo-dir:123e4567-e89b-12d3-a456-426614174000' })
        }).then(r => r.json());
        ok(tok.items[0].status === 'invalid', 'polo-dir:* 判为 invalid（不是路径）');
        ok((tok.config.imageDir || '') === '', 'polo-dir:* 不会被写进配置');
        const rel = await fetch(BASE + '/path-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scriptDir: 'Downloads\\脚本' })
        }).then(r => r.json());
        ok(rel.items[0].status === 'not-absolute', '相对路径 → not-absolute');

        // ---------- ⑦ 空值不覆盖已有路径 ----------
        console.log('\n【⑦】空值不覆盖已有配置');
        const keep = await fetch(BASE + '/path-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ colorImgDir: '' })
        }).then(r => r.json());
        ok(keep.config.colorImgDir === '', '显式传空串才会清空（语义明确）');
        const again = await fetch(BASE + '/path-config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageDir: colorDir })
        }).then(r => r.json());
        ok(again.config.colorImgDir === '' && again.config.imageDir === colorDir, '只改一项时其他项保持不变');

        // ---------- ⑧ 删文件后立刻读不到 ----------
        console.log('\n【⑧】删除磁盘文件后立即不可读');
        fs.unlinkSync(path.join(dir, 'row1_white.png'));
        const afterDel = await fetch(imgUrl);
        ok(afterDel.status === 404, '删除后同一 URL → 404（不冒充缓存）');

    } catch (e) {
        fail++; failures.push('运行异常: ' + (e && e.message));
        console.error('测试运行异常:', e && e.stack || e);
    } finally {
        if (server) { try { server.kill(); } catch (_) {} }
        await sleep(300);
        // 还原用户真实配置
        if (cfgBackup) fs.writeFileSync(CFG, cfgBackup); else { try { fs.unlinkSync(CFG); } catch (_) {} }
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    }

    // ---------- ⑨ 页面侧 path-config 纯函数 ----------
    console.log('\n【⑨】页面路径模块纯函数');
    {
        const src = fs.readFileSync(path.join(ROOT, 'path-config.js'), 'utf8');
        const store = {};
        const sandbox = {
            console, setTimeout, clearTimeout, Promise, JSON, Date, Number, String, Object, Array, RegExp, Error,
            localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
            document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, set innerHTML(v) {}, get innerHTML() { return ''; } }) },
            fetch: () => Promise.reject(new Error('offline')),
            AbortController: class { constructor() { this.signal = null; } abort() {} },
            window: {}
        };
        sandbox.globalThis = sandbox.sandbox = sandbox;
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox, { filename: 'path-config.js' });
        const PC = sandbox.window.PathConfig || sandbox.PathConfig;
        ok(!!PC, '模块加载并暴露 window.PathConfig');
        PC.saveAll({ colorImgDir: 'C:\\Users\\王同学\\Downloads\\Polo发品_颜色图\\' });
        ok(PC.read().colorImgDir === 'C:\\Users\\王同学\\Downloads\\Polo发品_颜色图', '末尾斜杠归一化，中文/空格不变');
        const p = PC.colorImagePath(2, 'white', '卫衣_全部合并_已审核_重填版_Non-hooded sweatshirt');
        ok(/row2[\\/]row2_white\.png$/.test(p), '颜色图绝对路径按 <目录>/<文件名>/rowN/rowN_color.png 拼接', p);
        const u = PC.imageUrl('C:\\a b\\图 1.png', false);
        ok(u.startsWith('http://127.0.0.1:8765/local-image?path='), '图片 URL 走本地服务');
        ok(!/file:\/\//.test(u), '不再出现 file:// 读取');
    }

    console.log('\n' + '='.repeat(54));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(54));
    process.exit(fail === 0 ? 0 : 1);
})();
