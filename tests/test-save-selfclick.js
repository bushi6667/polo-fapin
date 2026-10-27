// ============================================================
// 保存「自记账回声」验收测试（P0：自动保存的校验结果不能被自己那条旧链路覆盖）
//
// 链路：页3 saveDraft → savePublishProduct（后台 CDP 点保存）→ 注入点击在渲染器里 isTrusted === true
//       → 页3 observePage3SaveClick 也命中 → 再发 recordPublishSaveClick（clickButton=false，不校验）
//       → 覆盖第一条的 unverified / 把平台拒绝的行写成「已保存」。
//
// 覆盖：
//   1 CDP 点击后窗口期内到达的 recordPublishSaveClick 不写记录、不覆盖 unverified
//     1b 页3 已自己吞掉注入点击时，内存窗口立即撤销（不留着挡真人）
//   2 失败判定（verdict.failure）之后到达的 recordPublishSaveClick 不能把该行写成已保存
//   3 窗口期外（模拟 9 秒后）的用户真实手动点击仍正常记账（不能一刀切挡死）
//   4 publishFilled {skipped:true} → skippedCount+1、filledCount 不变、队列推进
//   5 publishFilled {skipped:false} → 原有行为不变
//   6 skipPublishRow 首行不一致 → 拒绝且不改任何状态；一致 → 正常跳过
// 运行：node tests/test-save-selfclick.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '..');
const BG_SRC = fs.readFileSync(path.join(root, 'chrome_extension/background.js'), 'utf8');
const PAGE3_SRC = fs.readFileSync(path.join(root, 'chrome_extension/content/page3.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra === undefined ? '' : ' :: ' + extra}`); }
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// 后台沙箱：复用 test-publish-queue 的 createEnv（真实 background.js）
// 只补 scripting mock：保存校验探针 / 页面标记脚本 / 命中计数读取 / elementFromPoint 兜底
// ============================================================
function backend(opts = {}) {
    const src = fs.readFileSync(path.join(__dirname, 'test-publish-queue.js'), 'utf8');
    const c = {
        require, __dirname: __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
        URLSearchParams, AbortController, TextDecoder, process
    };
    vm.createContext(c);
    vm.runInContext(src.slice(0, src.indexOf('(async function main()')), c);
    const env = vm.runInContext('createEnv()', c);

    const calls = [];              // 'mark' / 'read' / 'probe' / 'click'
    let hits = 0;                  // 页面 __poloAutoSaveHits
    let swallowPending = !!opts.swallow;

    env.ctx.chrome.scripting.executeScript = async ({ func }) => {
        const text = String(func || '');
        if (func && func.name === 'saveVerifyProbe') {
            calls.push('probe');
            if (opts.probeThrows) throw new Error('Cannot access contents of the page');
            return [{ result: opts.probeRaw === undefined ? { success: true, signals: ['successToast:保存成功'] } : opts.probeRaw }];
        }
        // 标记脚本：写 window.__poloAutoSaveAt，并回传点击前的命中计数
        if (text.includes('__poloAutoSaveAt')) { calls.push('mark'); return [{ result: hits }]; }
        // 点击后读命中计数：模拟页3 已自己吞掉这次注入点击
        if (text.includes('__poloAutoSaveHits')) {
            calls.push('read');
            if (swallowPending) { swallowPending = false; hits += 1; }
            return [{ result: hits }];
        }
        // elementFromPoint 兜底点击
        return [{ result: opts.fallbackClick === undefined ? true : opts.fallbackClick }];
    };
    // 记录 CDP 点击时机（验证「先打标记、后点击」）：__record 是 Node 侧回调
    env.ctx.__record = x => calls.push(x);
    env.run('realClickCDP = async function () { __record("click"); return { ok: true }; }');
    return { env, calls, hitCount: () => hits };
}

async function openTask(env, rows = [412, 415]) {
    const opened = await env.sendExternal({ action: 'openBatchPublish', rows, products: rows.map(row => ({ row })) });
    assert.equal(opened.ok, true, '任务创建失败: ' + JSON.stringify(opened));
    const tabId = env.store.polo_publish_task.currentTabId;
    const tab = env.tabs.find(t => t.id === tabId) || { url: '' };
    return {
        opened, tabId,
        sender: {
            tab: { id: tabId, url: tab.url },
            url: 'https://post.alibaba.com/product/publish?row=' + rows[0] + '&task=' + opened.taskId,
            frameId: 0
        }
    };
}
const savedMapOf = env => (env.store.polo_publish_verified_saved || {});
const taskOf = env => env.store.polo_publish_task;

// 模拟「后台那一刻已经过去了 N 毫秒」：把未消费窗口的时间戳往前推，不必真等
const ageWindows = (env, ms) => env.run(
    'autoSaveSelfClicks.forEach(list => list.forEach(t => { t.at = t.at - ' + Number(ms) + '; }))'
);
const windowSize = env => env.run('autoSaveSelfClicks.size');

// ============================================================
(async () => {
    console.log('=== 保存自记账回声 验收测试 ===\n');

    // ------------------------------------------------------------
    console.log('【1】CDP 点击后，窗口期内到达的 recordPublishSaveClick 不写记录、不覆盖 unverified');
    {
        // probeRaw 无任何信号 → 第一条只记 unverified；页3 这次没吞掉点击（swallow=false）→ 回声会到
        const { env, calls } = backend({ probeRaw: { signals: [] }, swallow: false });
        await delay(100);
        const { sender } = await openTask(env);
        const first = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(first && first.ok === true && first.unverified === true, '第一条：已记账但 unverified', JSON.stringify(first));
        ok(calls.indexOf('mark') >= 0 && calls.indexOf('click') >= 0 && calls.indexOf('mark') < calls.indexOf('click'),
            '点击前先打页面标记（不是点完才打）', calls.join(','));
        ok(windowSize(env) === 1, '内存窗口已登记（1 个未消费）');

        const echo = await env.sendInternal({ action: 'recordPublishSaveClick', row: 412, taskId: '', fileKey: '', x: 0, y: 0 }, sender);
        ok(echo && echo.ok === true && echo.ignored === true, '回声被丢弃（ok:true / ignored:true，页3 不会弹错误）', JSON.stringify(echo));
        ok(echo.reason === 'auto-save-window', 'reason=auto-save-window');
        const rec = savedMapOf(env)[''][412];
        ok(!!rec && rec.unverified === true, '记录仍是 unverified（没被覆盖成 verified）');
        ok(!rec.verified, '没有被写成 verified:true');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.savedCount === 1 && st.unverifiedSavedCount === 1, `面板仍是 已保存 1 / 未确认 1（实际 ${st.savedCount}/${st.unverifiedSavedCount}）`);
        ok(windowSize(env) === 0, '窗口一次性消费：不残留（真人随后再点不会被连坐）');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【1b】页3 已自己吞掉注入点击 → 内存窗口立即撤销');
    {
        const { env } = backend({ probeRaw: { success: true, signals: ['successToast:保存成功'] }, swallow: true });
        await delay(100);
        const { sender } = await openTask(env);
        const first = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(first && first.verified === true, '第一条 verified:true');
        ok(windowSize(env) === 0, '页3 吞掉后窗口已提前撤销（不会多挡一次真人点击）');
        // 真人紧接着点保存（页3 已经不会再发第二条，这里是"用户补救"场景）
        const manual = await env.sendInternal({ action: 'recordPublishSaveClick', row: 412, fileKey: '', x: 0, y: 0 }, sender);
        ok(manual && manual.ok === true && manual.ignored !== true, '真人点击正常记账（不被窗口误挡）', JSON.stringify(manual));
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【2】失败判定（平台拒绝保存）后到达的 recordPublishSaveClick 不能把该行写成已保存');
    {
        const { env } = backend({ probeRaw: { error: true, signals: ['formError:品牌不能为空'] }, swallow: false });
        await delay(100);
        const { sender } = await openTask(env);
        const first = await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(first && first.ok === false, '第一条：平台拒绝 → ok:false', JSON.stringify(first));
        ok(savedMapOf(env)[''] === undefined || savedMapOf(env)[''][412] === undefined, '第一条没有写记录');
        const echo = await env.sendInternal({ action: 'recordPublishSaveClick', row: 412, fileKey: '', x: 0, y: 0 }, sender);
        ok(echo && echo.ignored === true, '回声被丢弃', JSON.stringify(echo));
        ok(savedMapOf(env)[''] === undefined || savedMapOf(env)[''][412] === undefined, '仍然没有记录（不会被写成已保存 → 下次重发不会被跳过）');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.savedCount === 0, `面板已保存数仍为 0（实际 ${st.savedCount}）`);
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【3】窗口期外（模拟 9 秒后）的用户真实手动点击 → 仍正常记账（不能一刀切挡死）');
    {
        const { env } = backend({ probeRaw: { signals: [] }, swallow: false });
        await delay(100);
        const { sender } = await openTask(env);
        await env.sendInternal({ action: 'savePublishProduct', row: 412, x: 60, y: 30, fileKey: '' }, sender);
        ok(windowSize(env) === 1, '自动保存后存在 1 个未消费窗口');
        ageWindows(env, 9000);   // 时间往前推 9 秒 → 超过 AUTO_SAVE_CLICK_TTL_MS(8s)
        const manual = await env.sendInternal({ action: 'recordPublishSaveClick', row: 412, fileKey: '', x: 0, y: 0 }, sender);
        ok(manual && manual.ok === true && manual.ignored !== true, '窗口期外的点击照常记账', JSON.stringify(manual));
        const rec = savedMapOf(env)[''][412];
        ok(!!rec && rec.verified === true && rec.source === 'page3_save_click', '记录被更新为 verified（人工点击按旧行为"点了就记"）');
        ok(windowSize(env) === 0, '过期窗口被清掉，不残留');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【4】publishFilled {skipped:true} → skippedCount+1、filledCount 不变、队列推进');
    {
        const { env } = backend();
        await delay(100);
        const { opened, tabId } = await openTask(env, [412, 415]);
        const t0 = taskOf(env);
        ok(t0.currentRow === 412 && t0.filledCount === 0, '初始：当前行 412 / 已填 0');
        const r = await env.sendInternal({ action: 'publishFilled', row: 412, taskId: opened.taskId, skipped: true }, { tab: { id: tabId }, frameId: 0 });
        ok(r && r.ok === true, '上报被接受', JSON.stringify(r));
        const t1 = taskOf(env);
        ok(t1.filledCount === 0, `filledCount 不变（实际 ${t1.filledCount}）`);
        ok(Array.isArray(t1.filledRows) && t1.filledRows.length === 0, '不进 filledRows（待保存数不会虚增）');
        ok(t1.batchFilledDone === 0, `batchFilledDone 不变（实际 ${t1.batchFilledDone}）`);
        ok(Array.isArray(t1.skippedRows) && t1.skippedRows.length === 1 && Number(t1.skippedRows[0]) === 412, '进 skippedRows');
        ok(t1.remaining.length === 1 && Number(t1.remaining[0]) === 415, '队列推进（剩 415）');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.skippedCount === 1, `getPublishState 暴露 skippedCount（实际 ${st.skippedCount}）`);
        ok(st.filledCount === 0 && st.pendingSaveCount === 0, `面板：已填 ${st.filledCount} / 待保存 ${st.pendingSaveCount}（不再冒充 100/100）`);
        ok(t1.currentRow === 415 && t1.currentTabId !== null, '已开下一行（没卡在跳过行）');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【5】publishFilled {skipped:false} → 原有行为不变');
    {
        const { env } = backend();
        await delay(100);
        const { opened, tabId } = await openTask(env, [412, 415]);
        const r = await env.sendInternal({ action: 'publishFilled', row: 412, taskId: opened.taskId }, { tab: { id: tabId }, frameId: 0 });
        ok(r && r.ok === true, '上报被接受', JSON.stringify(r));
        const t = taskOf(env);
        ok(t.filledCount === 1, `filledCount+1（实际 ${t.filledCount}）`);
        ok(t.filledRows.length === 1 && Number(t.filledRows[0]) === 412, '进 filledRows');
        ok(t.batchFilledDone === 1, `batchFilledDone+1（实际 ${t.batchFilledDone}）`);
        ok((t.skippedRows || []).length === 0, 'skippedRows 不变');
        const st = await env.sendExternal({ action: 'getPublishState' });
        ok(st.skippedCount === 0 && st.filledCount === 1 && st.pendingSaveCount === 1, `面板：已填 1 / 待保存 1 / 跳过 0（实际 ${st.filledCount}/${st.pendingSaveCount}/${st.skippedCount}）`);
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【6】skipPublishRow 首行守卫：不一致 → 拒绝且不改任何状态；一致 → 正常跳过');
    {
        const { env } = backend();
        await delay(100);
        await openTask(env, [412, 415]);
        // 造出"当前行 412、但队列首行被别的东西顶成 999"的错位（模拟旧版本删错行后的卡死态）
        await env.run('(async () => { const t = await loadPublishTask(); t.remaining = [999, 415]; await savePublishTask(t); return t; })()');
        const before = JSON.parse(JSON.stringify(taskOf(env)));
        const bad = await env.sendExternal({ action: 'skipPublishRow' });
        ok(bad && bad.ok === false, '首行不一致 → 拒绝', JSON.stringify(bad));
        ok(/不一致/.test(String(bad.message || '')), '错误说明是队列首行不一致');
        const after = taskOf(env);
        ok(after.currentRow === before.currentRow && after.currentTabId === before.currentTabId, '当前行/标签未被改动');
        ok(JSON.stringify(after.remaining) === JSON.stringify(before.remaining), '队列未被删行（没"尽力而为"地删错）');
        ok((after.skippedRows || []).length === 0, '没有写入 skippedRows');

        // 恢复一致 → 正常跳过
        await env.run('(async () => { const t = await loadPublishTask(); t.remaining = [412, 415]; await savePublishTask(t); return t; })()');
        const good = await env.sendExternal({ action: 'skipPublishRow' });
        ok(good && good.ok === true && Number(good.row) === 412, '首行一致 → 正常跳过', JSON.stringify(good));
        const t3 = taskOf(env);
        ok(JSON.stringify(t3.remaining) === JSON.stringify([415]), '只删了当前这一行');
        ok(t3.skippedRows.length === 1 && Number(t3.skippedRows[0]) === 412, '该行进 skippedRows');
        await env.run('stopPublishTick()');
    }

    // ------------------------------------------------------------
    console.log('【7】页3 点击监听：3 秒内的注入标记 → return 不记账；无标记/标记过期 → 正常记账');
    {
        // 真实 observePage3SaveClick + 假 document，直接喂 click 事件
        const listeners = {};
        const messages = [];
        const logs = [];
        const saveBtn = { innerText: '保存', textContent: '保存' };
        const c = {
            document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
            window: {},
            currentProduct: { row: 412, _publishTaskId: 'pt_test', _publishFileKey: '' },
            getTaskFromUrl: () => 'pt_test',
            log: (m, t) => logs.push({ m, t }),
            sendMessageRetry: async msg => { messages.push(msg); return { ok: true }; },
            Date
        };
        vm.createContext(c);
        const lines = PAGE3_SRC.split('\n');
        const start = lines.findIndex(l => /^function observePage3SaveClick\(/.test(l));
        const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
        vm.runInContext(lines.slice(start, end + 1).join('\n') + '\nobservePage3SaveClick();', c);
        const click = ev => listeners.click({ isTrusted: true, target: { closest: () => saveBtn }, ...ev });

        click({});   // 无标记（用户手动点）
        await delay(10);
        ok(messages.length === 1 && messages[0].action === 'recordPublishSaveClick', '无标记 → 正常回传记账');
        ok(c.window.__poloAutoSaveHits === undefined, '无标记时不计命中');

        c.window.__poloAutoSaveAt = Date.now();          // 后台点击前 1ms 打的标记
        c.window.__poloAutoSaveMarkMs = 3000;
        click({});
        await delay(10);
        ok(messages.length === 1, '3 秒内的标记 → 不回传（不产生回声）');
        ok(c.window.__poloAutoSaveHits === 1, '记下已吞掉 1 次注入点击（供后台撤销内存窗口）');

        c.window.__poloAutoSaveAt = Date.now() - 5000;   // 标记过期
        click({});
        await delay(10);
        ok(messages.length === 2, '标记过期（5 秒前）→ 用户点击照常记账');

        click({ trusted: false, isTrusted: false });
        await delay(10);
        ok(messages.length === 2, 'isTrusted=false 仍被忽略（原判据未退化）');
    }

    console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
    if (fail) console.log('失败项:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
