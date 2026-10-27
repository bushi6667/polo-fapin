// ============================================================
// 套图日志可观测性：逐步可见 / 前缀统一 / 节流 / 截断 / 可关 / 不阻断业务
// 直接加载生产源码（vm 沙箱），不复制业务分支
// 运行：node tests/test-suite-logging.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 统一为 LF：函数体切片依赖 indexOf('\n}\n')，CRLF 会导致截断。
const SUITE_SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'suite', 'suite-doubao.js'), 'utf8').replace(/\r\n/g, '\n');
const COLOR_SRC = fs.readFileSync(path.join(__dirname, '..', 'chrome_extension', 'content', 'doubao.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

/* ---------------- 假页面 ----------------
   只实现被日志/流程真正用到的 DOM 面：输入框、文件控件、结果图、忙态、按钮 */
function makeEnv(opts = {}) {
    const logs = [];        // { level, text }
    const clock = { t: 1700000000000 };
    const state = {
        images: ['https://p/anchor_old.png'],
        busy: false,
        previews: 0,
        controls: ['图像生成'],
        sendClicks: 0,
        clock
    };

    const push = (level) => (...args) => logs.push({ level, text: args.map(String).join(' ') });
    const consoleStub = opts.noConsole ? undefined : {
        log: push('log'), warn: push('warn'), error: push('error')
    };

    const mkImg = (src, size = 256) => ({
        src, currentSrc: src, naturalWidth: 320, naturalHeight: 256, className: 'result',
        getBoundingClientRect: () => ({ width: size, height: size }),
        closest: () => null
    });

    const input = {
        tagName: 'TEXTAREA', value: '', focus() {},
        getBoundingClientRect: () => ({ width: 300, height: 40 }), closest: () => null
    };

    const fileInput = {
        files: null,
        // 模拟「提交后豆包把素材渲染成预览缩略图」：预览数 +1
        dispatchEvent() { state.previews = state.previews + 1; return true; }
    };

    const surface = { querySelectorAll: () => Array.from({ length: state.previews }, (_, i) => mkImg('blob:preview' + i, 80)) };

    const env = {
        console: consoleStub,
        location: { href: 'https://www.doubao.com/chat/' },
        URL, Set, Map, Promise, Array, Object, String, Number, Math, JSON, Error, RegExp,
        DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
        Event: class { constructor(type) { this.type = type; } },
        File: class { constructor(parts, name, opt) { this.parts = parts; this.name = name; this.type = (opt || {}).type; this.size = 10; } },
        FileReader: class {
            readAsDataURL(blob) {
                Promise.resolve().then(() => { this.result = 'data:' + blob.type + ';base64,QUJD'; this.onload(); });
            }
        },
        CustomEvent: class { constructor(type) { this.type = type; } },
        setTimeout: (fn) => { queueMicrotask(fn); return 1; },
        Date: { now: () => clock.t },
        fetch: async () => ({ ok: true, blob: async () => ({ size: 1024, type: 'image/png' }) }),
        document: {
            body: { innerText: '' },
            dispatchEvent() {},
            querySelector(sel) {
                if (sel === 'input[type="file"]') return fileInput;
                if (sel.includes('progressbar') || sel.includes('uploading') || sel.includes('upload-error')) return null;
                if (sel.includes('loading')) return null;
                if (sel === '.guidance-input-surface') return surface;
                if (sel === '#input-engine-container') return null;
                if (sel.includes('contenteditable') || sel === 'textarea') return opts.noInput ? null : input;
                if (sel === 'button[data-testid="chat_input_send_button"]') {
                    return { disabled: false, click() { state.sendClicks++; state.busy = true; } };
                }
                return null;
            },
            querySelectorAll(sel) {
                if (sel === 'button,[role="combobox"]') {
                    return state.controls.map(text => ({
                        innerText: text, textContent: text, disabled: false,
                        getClientRects: () => [{}],
                        click() { state.controls = ['Seedream 4.5', '比例 1:1']; }
                    }));
                }
                if (sel === 'img') return state.images.map(u => mkImg(u));
                if (sel === '[class*="generating"], [class*="typing"]') {
                    return state.busy ? [{ getClientRects: () => [{}], offsetHeight: 10 }] : [];
                }
                return [];
            }
        },
        chrome: {
            runtime: {
                lastError: null,
                onMessage: { addListener(fn) { env.__listener = fn; } },
                sendMessage: (req, cb) => {
                    if (req.command === 'clear') input.value = '';
                    else if (req.command === 'character') input.value += req.character;
                    if (cb) cb({ success: true });
                }
            }
        }
    };
    env.globalThis = env;
    if (opts.throwingConsole) {
        const boom = () => { throw new Error('console 桩异常'); };
        env.console = { log: boom, warn: boom, error: boom };
    }
    if (opts.verbose === false) env.__src = SUITE_SRC.replace('const SUITE_VERBOSE = true;', 'const SUITE_VERBOSE = false;');
    vm.runInNewContext(env.__src || SUITE_SRC, env, { filename: 'suite-doubao.js' });
    return { env, logs, state, input };
}

/* 跑一个套图动作（走真实消息入口） */
function call(env, payload) {
    return new Promise((resolve, reject) => {
        const binding = { taskId: 't1', fileKey: 'A__', rowNum: 85 };
        env.__listener(Object.assign({ binding }, payload), {}, (r) => {
            if (r && r.success === false) reject(new Error(r.error));
            else resolve(r);
        });
    });
}

const has = (logs, kw) => logs.filter(l => l.text.includes(kw));
const joined = (logs) => logs.map(l => l.text).join('\n');

(async function main() {
    console.log('=== 套图控制台日志 测试 ===\n');

    // ---------------- 1. 关键节点都会打印 ----------------
    console.log('【1】关键节点逐步可见（准备设置/上传/输入/发送/出图/下载/收尾）');
    {
        const { env, logs, state, input } = makeEnv();
        // baseline：行开始
        await call(env, { action: 'suite-baseline' });
        ok(has(logs, '▶ row85 开始').length === 1, '行开始: ▶ row85 开始');

        // 进入图像生成模式
        await call(env, { action: 'suite-settings', settings: {} });
        ok(has(logs, '切换到图像生成模式').length === 1, '准备设置: 切换到图像生成模式...');
        ok(has(logs, '已点击图像生成按钮').length === 1, '准备设置: 已点击图像生成按钮');

        // 上传
        state.previews = 0;
        await call(env, { action: 'suite-upload', assets: [{ url: 'https://cdn.x.com/a/row85_main.jpg', filename: 'row85_main.jpg' }] });
        ok(has(logs, '上传图片: row85_main.jpg').length === 1, '上传: 上传图片: <文件名>');
        ok(has(logs, '上传完成: row85_main.jpg').some(l => /\(\d+ms\)/.test(l.text)), '上传: 上传完成 + 耗时');

        // 输入
        const prompt = '把这张图改成纯白背景，保持产品不变'.repeat(10); // 200 字
        await call(env, { action: 'suite-type', text: prompt });
        ok(has(logs, '输入提示词').length === 1, '输入: 输入提示词...');
        ok(has(logs, '提示词已输入').some(l => l.text.includes('字')), '输入: 提示词已输入（长度 字）');

        // 发送
        await call(env, { action: 'suite-send' });
        ok(has(logs, '发送消息').length === 1, '发送: 发送消息...');
        ok(has(logs, '消息已发送').length === 1, '发送: 消息已发送');

        // 出图：5 张新图
        state.busy = false;
        state.images = state.images.concat([1, 2, 3, 4, 5].map(i => `https://p/new_${i}.png`));
        env.getRawUrl = (u) => u + (u.includes('?') ? '&' : '?') + 'image_raw=1';
        await call(env, { action: 'suite-poll', expectCount: 5 });
        ok(has(logs, '✅ 检测到 5 张新图').length === 1, '出图: ✅ 检测到 5 张新图 (已达到目标 5 张)');
        ok(has(logs, '✓ 1/5:') && has(logs, '无水印原图').length >= 5, '下载: 每张 ✓ i/n: xxx (无水印原图) → 文件名');
        ok(has(logs, '下载任务结束: 成功 5/5，其中无水印 5 张').length === 1, '收尾: 下载任务结束: 成功 a/b，其中无水印 c 张');
        ok(has(logs, '✔ row85 完成').some(l => /耗时 [\d.]+s/.test(l.text)), '行完成: ✔ row85 完成（耗时 Xs）');
        ok(state.sendClicks === 1, '日志不改业务：发送仍只点击 1 次');
        ok(input.value === prompt, '日志不改业务：提示词仍完整输入');
    }

    // ---------------- 2. 前缀统一 ----------------
    console.log('\n【2】前缀统一为 [豆包套图]');
    {
        const { env, logs } = makeEnv();
        await call(env, { action: 'suite-baseline' });
        await call(env, { action: 'suite-settings', settings: {} });
        ok(logs.length > 0 && logs.every(l => l.text.startsWith('[豆包套图]')), `每条日志都以 [豆包套图] 开头（${logs.length} 条）`);
        ok(!logs.some(l => l.text.includes('[suite-doubao]')), '不再输出旧前缀 [suite-doubao]');
    }

    // ---------------- 3. 轮询进度节流 ----------------
    console.log('\n【3】轮询进度节流（500ms 一次轮询，10 秒内最多 2 条进度）');
    {
        const { env, logs, state } = makeEnv();
        await call(env, { action: 'suite-baseline' });
        state.images = state.images.concat(['https://p/n1.png', 'https://p/n2.png']);
        const before = logs.length;
        for (let i = 0; i < 20; i++) {
            state.clock.t += 500;          // 每 tick 前进 500ms（与线上 500ms 轮询一致）
            await call(env, { action: 'suite-poll', expectCount: 5 });
        }
        const progress = logs.slice(before).filter(l => l.text.includes('图片增加') || l.text.includes('仍在等待'));
        ok(progress.length <= 5, `20 次 tick（10s）进度日志 ≤5 条（实际 ${progress.length}）`);
        ok(progress.length >= 1, '至少有一条进度日志（能看到确实在等）');
        ok(logs.slice(before).every(l => l.text.startsWith('[豆包套图]')), '进度日志前缀一致');
    }

    // ---------------- 4. 提示词截断 ----------------
    console.log('\n【4】提示词截断（200 字只显示前 40 字）');
    {
        const { env, logs } = makeEnv();
        const prompt = 'A'.repeat(150) + 'B'.repeat(50);
        await call(env, { action: 'suite-baseline' });
        await call(env, { action: 'suite-type', text: prompt });
        const line = has(logs, '输入提示词')[0];
        ok(!!line, '存在「输入提示词」日志');
        const msg = line ? line.text.replace('[豆包套图]', '').replace(/^\s*row\d+\s+\+?[\d.]+s\s*/, '').trim() : '';
        ok(!line.text.includes(prompt), '日志不含完整正文');
        ok(msg.length < 60, `提示词日志正文长度 < 60（实际 ${msg.length}）`);
        ok(line.text.includes('A'.repeat(40)) && !line.text.includes('A'.repeat(41)), '截断到 40 字并带省略号');
    }

    // ---------------- 5. SUITE_VERBOSE=false ----------------
    console.log('\n【5】SUITE_VERBOSE=false 只打关键节点');
    {
        const { env, logs, state } = makeEnv({ verbose: false });
        await call(env, { action: 'suite-baseline' });
        await call(env, { action: 'suite-settings', settings: {} });
        state.previews = 0;
        await call(env, { action: 'suite-upload', assets: [{ url: 'https://cdn.x.com/a/m.jpg', filename: 'm.jpg' }] });
        await call(env, { action: 'suite-type', text: '短提示词' });
        await call(env, { action: 'suite-send' });
        state.busy = false;
        state.images = state.images.concat([1, 2, 3, 4, 5].map(i => `https://p/n${i}.png`));
        env.getRawUrl = (u) => u + '?image_raw=1';
        await call(env, { action: 'suite-poll', expectCount: 5 });

        const text = joined(logs);
        ok(has(logs, '▶ row85 开始').length === 1, '关键节点保留: 行开始');
        ok(has(logs, '✅ 检测到 5 张新图').length === 1, '关键节点保留: 出图');
        ok(has(logs, '✔ row85 完成').length === 1, '关键节点保留: 行完成');
        ok(!text.includes('上传图片') && !text.includes('上传完成'), '细节关闭: 上传');
        ok(!text.includes('输入提示词') && !text.includes('提示词已输入'), '细节关闭: 提示词');
        ok(!text.includes('发送消息') && !text.includes('消息已发送'), '细节关闭: 发送');
        ok(!text.includes('切换到图像生成模式'), '细节关闭: 模式切换');
        ok(!text.includes('  ✓ '), '细节关闭: 每张下载明细');
        ok(logs.length <= 6, `总日志条数很少（实际 ${logs.length}）`);
    }

    // ---------------- 6. console 不存在 ----------------
    console.log('\n【6】console 不存在（vm 沙箱）时静默跳过，不抛错');
    {
        const { env, state } = makeEnv({ noConsole: true });
        let err = null;
        try {
            await call(env, { action: 'suite-baseline' });
            await call(env, { action: 'suite-settings', settings: {} });
            await call(env, { action: 'suite-type', text: 'hi' });
            state.busy = false;
            await call(env, { action: 'suite-poll', expectCount: 5 });
        } catch (e) { err = e; }
        ok(!err, `无 console 时不抛错（${err && err.message}）`);
    }

    // ---------------- 7. 日志抛异常不阻断业务 ----------------
    console.log('\n【7】console 被替换成会抛的桩，业务函数照常返回');
    {
        const { env, state, input } = makeEnv({ throwingConsole: true });
        let err = null;
        let uploadRes = null, typeRes = null;
        try {
            await call(env, { action: 'suite-baseline' });
            await call(env, { action: 'suite-settings', settings: {} });
            state.previews = 0;
            uploadRes = await call(env, { action: 'suite-upload', assets: [{ url: 'https://cdn.x.com/a/m.jpg', filename: 'm.jpg' }] });
            typeRes = await call(env, { action: 'suite-type', text: 'hello' });
            await call(env, { action: 'suite-send' });
            state.busy = false;
            state.images = state.images.concat([1, 2, 3, 4, 5].map(i => `https://p/n${i}.png`));
            env.getRawUrl = (u) => u + '?image_raw=1';
            const poll = await call(env, { action: 'suite-poll', expectCount: 5 });
            ok(poll.result && poll.result.ready === true, '日志抛异常时轮询仍返回 ready');
        } catch (e) { err = e; }
        ok(!err, `日志抛异常不中断流程（${err && err.message}）`);
        ok(uploadRes && uploadRes.result && uploadRes.result.ok === true, '上传仍成功');
        ok(typeRes && typeRes.result && typeRes.result.length === 5, '输入仍成功');
        ok(input.value === 'hello', '输入内容不受影响');
    }

    // ---------------- 8. 换色侧 log() 按 type 分级 ----------------
    console.log('\n【8】doubao.js 的 log()：error→console.error、warn→console.warn、默认→console.log');
    {
        const logs = [];
        const push = (level) => (...a) => logs.push({ level, text: a.join(' ') });
        const env = {
            console: { log: push('log'), warn: push('warn'), error: push('error') },
            chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {}, lastError: null } },
            document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
            window: {}, location: { href: 'https://www.doubao.com/' },
            setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
            URL, Set, Map, Promise, Array, Object, String, Number, Math, JSON, Error, RegExp,
            FileReader: class {}, Blob: class {}, fetch: async () => ({})
        };
        env.globalThis = env;
        vm.runInNewContext(COLOR_SRC, env, { filename: 'doubao.js' });

        // 只截取 log 定义体求值，避免依赖注入时的其它状态
        const fnSrc = COLOR_SRC.slice(COLOR_SRC.indexOf('function log(msg'), COLOR_SRC.indexOf('function log(msg') + 260);
        const sandbox = { console: env.console, captured: [] };
        sandbox.__fn = vm.runInNewContext('(' + fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 2) + ')', sandbox);

        sandbox.__fn('文案A', 'error');
        sandbox.__fn('文案B', 'warn');
        sandbox.__fn('文案C');
        sandbox.__fn('文案D', 'info');

        ok(logs.length >= 4, '日志被输出');
        const byText = (t) => logs.filter(l => l.text.includes(t))[0];
        ok(byText('文案A') && byText('文案A').level === 'error', 'type=error → console.error');
        ok(byText('文案B') && byText('文案B').level === 'warn', 'type=warn → console.warn');
        ok(byText('文案C') && byText('文案C').level === 'log', '默认 → console.log');
        ok(byText('文案D') && byText('文案D').level === 'log', 'type=info → console.log');
        ok(logs.filter(l => l.text.includes('文案')).every(l => l.text.includes('[豆包AI换色]')), '前缀与换色文案保持不变');
        ok(byText('文案A').text === '[豆包AI换色] 文案A', `输出文案不变（${byText('文案A').text}）`);
        ok(/type=error|console\.error/.test(COLOR_SRC.slice(COLOR_SRC.indexOf('function log(msg'), COLOR_SRC.indexOf('function log(msg') + 400)), '源码里确实按 type 分流');
    }

    console.log('\n' + '='.repeat(52));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(52));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });
