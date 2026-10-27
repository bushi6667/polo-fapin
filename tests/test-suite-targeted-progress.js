/**
 * 指定重生成的进度口径：只跑 1 个步骤时，进度必须是 x/1，不能显示成整套 x/5。
 * 真机反馈：勾了指定行(5)重生成，顶部进度条却像整套套图在跑。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '发品助手.html'), 'utf8').replace(/\r\n/g, '\n');

function extractFn(name) {
    const lines = HTML.split('\n');
    const re1 = new RegExp('^function ' + name + '\\('), re2 = new RegExp('^async function ' + name + '\\(');
    let s = -1;
    for (let i = 0; i < lines.length; i++) if (re1.test(lines[i]) || re2.test(lines[i])) { s = i; break; }
    if (s < 0) throw new Error('未找到函数 ' + name);
    for (let j = s + 1; j < lines.length; j++) if (lines[j] === '}') return lines.slice(s, j + 1).join('\n');
    throw new Error('函数未闭合 ' + name);
}

let pass = 0, fail = 0; const bad = [];
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, bad.push(m), console.log('  ❌ ' + m)); };

function env({ previous = null } = {}) {
    const saved = [];
    const fills = [];
    const fillEl = { style: { width: '' } };
    const wrapEl = { style: { display: 'none' } };
    const sb = {
        console: { log() {}, warn() {}, error() {} },
        SUITE_FIVE_TOTAL: 5,
        readSuiteAutoState: () => previous,
        saveSuiteAutoState: (s) => saved.push(s),
        document: { getElementById: (id) => (id === 'suiteProgressWrap' ? wrapEl : id === 'suiteFill' ? fillEl : null) },
        Error, Math, Number, String
    };
    vm.createContext(sb);
    vm.runInContext(extractFn('suiteSetProgress'), sb, { filename: '发品助手.html:suiteSetProgress' });
    return { run: sb.suiteSetProgress, saved, fillEl, wrapEl };
}

console.log('=== 指定重生成进度口径 ===');

// 1) 只跑 1 个步骤：总数为 1，完成即 100%
{
    const e = env();
    e.run({ jobId: 'j1', fileKey: 'f', rowNum: 16, phase: 'generating', done: 1, total: 1 });
    const s = e.saved.pop();
    ok(s.total === 1, 'total=1（只重生成 1 张时进度按 1 张算）', JSON.stringify(s));
    ok(e.fillEl.style.width === '100%', '进度条 100%（不是 20%）', e.fillEl.style.width);
}
// 2) 半程：1/2 = 50%
{
    const e = env();
    e.run({ jobId: 'j2', fileKey: 'f', rowNum: 19, phase: 'generating', done: 1, total: 2 });
    ok(e.fillEl.style.width === '50%', '1/2 显示 50%', e.fillEl.style.width);
}
// 3) 整套仍按 5
{
    const e = env();
    e.run({ jobId: 'j3', fileKey: 'f', rowNum: 22, phase: 'generating', done: 2 });
    const s = e.saved.pop();
    ok(s.total === 5, '未传 total 时退回整套 5', JSON.stringify(s));
    ok(e.fillEl.style.width === '40%', '2/5 显示 40%', e.fillEl.style.width);
}
// 4) 暂停判定不受影响
{
    const e = env({ previous: { jobId: 'j4', paused: true } });
    let threw = false;
    try { e.run({ jobId: 'j4', fileKey: 'f', rowNum: 1, phase: 'generating', done: 0, total: 1 }); } catch (_) { threw = true; }
    ok(threw, '已暂停的任务写进度仍会抛错（暂停语义不变）');
}
// 5) 源码口径：runSuiteFiveJob 里 total 按 target 计算，且所有进度调用都带 total
{
    const fn = extractFn('runSuiteFiveJob');
    ok(/const total = targeted \? Math\.max\(1, selected\.length\) : SUITE_FIVE_TOTAL;/.test(fn),
        'runSuiteFiveJob：targeted 时 total = 本次选中的步骤数');
    const calls = fn.match(/suiteSetProgress\(\{[\s\S]*?\}\);/g) || [];
    const missing = calls.filter(c => !/\btotal\b/.test(c));
    ok(calls.length > 0 && missing.length === 0,
        'runSuiteFiveJob：所有 suiteSetProgress 调用都传 total（' + calls.length + ' 处）',
        missing.join(' | '));
    ok(/let doneCount = targeted \? 0 : SUITE_STEP_KEYS\.filter/.test(fn),
        'runSuiteFiveJob：指定重生成从 0 开始计数（否则出现 5/1 这种倒挂进度）');
    ok(/const names = selected\.map\(s => `\$\{s\.key\} \$\{s\.name\}`\)/.test(fn) && /指定重生成完成/.test(fn),
        '完成提示改成「指定重生成完成（N 张：…）」');
    ok(/if \(missingKeys\.length && !targeted\)/.test(fn),
        '指定重生成不再报「缺 111/222…」');
}
// 6) 顶部横幅：标题与分母都跟着「是否指定重生成」走
ok(/bannerGoal=Number\(state\.total\)\|\|/.test(HTML) && /\$\{state\.done\|\|0\}\/\$\{bannerGoal\}/.test(HTML),
    '顶部横幅分母走 bannerGoal（不再写死 /5）');
ok(/bannerKind=.*'指定重生成':'套图任务'/.test(HTML),
    '顶部横幅标题区分「指定重生成」与「套图任务」');
const UNI = fs.readFileSync(path.join(ROOT, 'unified-task-progress.js'), 'utf8').replace(/\r\n/g, '\n');
ok(/const suiteGoal = \(\) => Number\(suite\.total\)/.test(UNI) && !/suite\.total \|\| 5/.test(UNI),
    '统一进度条分母走 suiteGoal()，不再出现 suite.total || 5');

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail) console.log('失败项：' + bad.join(' / '));
process.exit(fail ? 1 : 0);
