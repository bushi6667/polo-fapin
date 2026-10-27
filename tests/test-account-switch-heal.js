/**
 * 换号链路的真实函数测试：内容脚本自愈 + 复核不再读早 + actualSeq 采证
 *
 * 真机背景：豆包标签内容脚本死亡（扩展更新后旧标签注入脚本失效）时，
 * 自动换号的 7 个候选全部失败「重载后读不到账号列表：内容脚本无响应」；
 * 手动刷新豆包页后立刻成功。这里把自愈与复核逻辑用真实函数跑一遍。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BG = fs.readFileSync(path.join(ROOT, 'chrome_extension', 'background.js'), 'utf8').replace(/\r\n/g, '\n');

function sliceFn(name) {
    const startRe = new RegExp('^async function ' + name + '\\(', 'm');
    const startRe2 = new RegExp('^function ' + name + '\\(', 'm');
    const lines = BG.split('\n');
    let s = -1;
    for (let i = 0; i < lines.length; i++) {
        if (startRe.test(lines[i]) || startRe2.test(lines[i])) { s = i; break; }
    }
    if (s < 0) throw new Error('未找到函数: ' + name);
    for (let j = s + 1; j < lines.length; j++) {
        if (lines[j] === '}') return lines.slice(s, j + 1).join('\n');
    }
    throw new Error('函数未闭合: ' + name);
}

const SRC = ['doubaoAccountSleep', 'waitDoubaoTabReloaded', 'recoverDoubaoAccountSwitch'].map(sliceFn).join('\n\n');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { pass++; console.log('  ✅ ' + msg); }
    else { fail++; failures.push(msg); console.log('  ❌ ' + msg); }
}

// responses: 每次 sendMessage 的返回值序列（null = 抛错/无响应，模拟内容脚本死亡）
function env({ responses, target = '用户1586744' }) {
    let i = 0;
    const reloads = [];
    const sb = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout: t => clearTimeout(t),
        chrome: {
            tabs: {
                sendMessage: async (tabId, payload) => {
                    const r = responses[Math.min(i, responses.length - 1)];
                    i++;
                    if (r === null) throw new Error('Could not establish connection. Receiving end does not exist.');
                    return r;
                },
                reload: async () => { reloads.push(1); },
                get: async () => ({ status: 'complete' })
            }
        }
    };
    vm.createContext(sb);
    vm.runInContext(SRC, sb, { filename: 'background.js:switch-heal' });
    return { sb, reloads, run: () => sb.recoverDoubaoAccountSwitch(7, target), idx: () => i };
}

(async () => {
    console.log('=== 换号自愈与复核（真实函数）===');

    console.log('【1】内容脚本死亡 → 自动刷新一次 → 切号成功');
    {
        const e = env({ responses: [null, null, null, null, null, null, null, null, null, null,
            { ok: true, current: '用户1586744', accounts: [] }] });
        const r = await e.run();
        ok(r.ok === true, '刷新后切号成功');
        ok(e.reloads.length === 1, '只刷新了一次（实际 ' + e.reloads.length + '）');
        ok(r.repaired === true, '回包标记 repaired，便于排障');
    }

    console.log('【2】刷新后仍无响应 → 不再循环刷新，如实报 infra');
    {
        const e = env({ responses: [null] });
        const r = await e.run();
        ok(r.ok === false && r.infra === true, '返回 infra:true（不再当普通切号失败）');
        ok(e.reloads.length === 1, '刷新严格一次，绝不无限重载');
        ok(/内容脚本无响应/.test(r.error), '错误文案点明根因：' + r.error.slice(0, 40));
        ok(Array.isArray(r.actualSeq) && r.actualSeq.length === 0, 'actualSeq 为空（一次都没读到）');
    }

    console.log('【3】复核读早了：第一次读到上一个号，第二次读到目标');
    {
        const e = env({ responses: [{ ok: true, current: '用户441103', accounts: [] },
            { ok: true, current: '用户1586744', accounts: [] }] });
        const r = await e.run();
        ok(r.ok === true, '第二次命中目标即成功（不再拿第一次的旧值判失败）');
        // 命中那次也记进序列，排障时能看出"旧值 → 目标"的演变
        ok(JSON.stringify(r.actualSeq) === '["用户441103","用户1586744"]',
            'actualSeq 记录了演变过程：' + JSON.stringify(r.actualSeq));
    }

    console.log('【4】真的一直切错：序列恒为同一个别的号');
    {
        const e = env({ responses: [{ ok: true, current: '再来一口咖喱🏸', accounts: [] }] });
        const r = await e.run();
        ok(r.ok === false && /用户名不匹配/.test(r.error), '如实报不匹配');
        ok(r.expect === '用户1586744' && r.actual === '再来一口咖喱🏸', '带回 expect / actual');
        ok(r.actualSeq.length >= 10 && r.actualSeq.every(x => x === '再来一口咖喱🏸'),
            'actualSeq 恒定 → 说明不是"读早了"，是真切错（序列长度 ' + r.actualSeq.length + '）');
    }

    console.log('【5】登录墙优先');
    {
        const e = env({ responses: [{ ok: true, loginWall: true, current: 'x', accounts: [] }] });
        const r = await e.run();
        ok(r.needLogin === true, '登录墙优先于名字比对');
        ok(e.reloads.length === 0, '登录墙不触发刷新');
    }

    console.log(`\n通过 ${pass}，失败 ${fail}`);
    if (fail) console.log('失败项：' + failures.join(' / '));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
