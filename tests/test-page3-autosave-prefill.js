// 页3 填入后自动保存 + 预填标记（不跳行 / 重填清标记）验收测试
// 方式：把 chrome_extension/content/page3.js 的真实函数切片放进 Node vm 执行；
//       background.js 侧复用 test-publish-queue.js 的 createEnv 真实后台环境。
// 运行：node tests/test-page3-autosave-prefill.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '..');
const PAGE3_SRC = fs.readFileSync(path.join(root, 'chrome_extension/content/page3.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra === undefined ? '' : ' :: ' + extra}`); }
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// 按「函数头 → 首个顶格 }」切函数（与 test-publish-refresh 同规则）
function fn(name, source = PAGE3_SRC) {
    const lines = source.split('\n');
    const start = lines.findIndex(l => new RegExp('^(?:async )?function ' + name + '\\(').test(l));
    const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '}');
    assert(start >= 0 && end > start, '切片失败: ' + name);
    return lines.slice(start, end + 1).join('\n');
}

// ============================================================
// 页3 沙箱：只提供 loadBatchProduct / 一键填入回调真正用到的东西
// ============================================================
function pageEnv(opts = {}) {
    const events = [];
    const logs = [];
    const messages = [];
    const store = new Map(opts.store || []);
    const removedKeys = [];
    const row = opts.row === undefined ? 412 : opts.row;
    const task = opts.task || 'pt_test';

    const saveBtn = {
        innerText: '保存', offsetHeight: 10,
        scrollIntoView() { events.push('scroll'); },
        getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 })
    };
    const btn = { disabled: false, style: {} };

    const c = {
        URLSearchParams,
        window: { location: { search: '?row=' + row + '&task=' + task } },
        sessionStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, v); events.push('marker:set'); },
            removeItem: k => { removedKeys.push(k); store.delete(k); events.push('marker:remove'); }
        },
        currentProduct: null,
        document: {
            // 表单就绪探测（waitPublishFormReady）：属性项 >=3 且存在「保存」按钮才算就绪，
            // 这里直接给足，避免测试里空等 60s
            querySelectorAll: sel => {
                const k = String(sel);
                if (k === 'button') return [saveBtn];
                if (k === '.sell-catProp-item') return [{}, {}, {}];
                return [];
            },
            getElementById: id => (id === 'polo-autofill-btn' ? btn : null),
            addEventListener: () => {}
        },
        updateProductInfo() {},
        log: (m, t) => logs.push({ m, t }),
        ensureTabActive: async () => {},
        startHeartbeat: () => () => {},
        setTimeout: callback => setTimeout(callback, 0),
        sleep3: async () => {},
        getTaskFromUrl: () => task,
        getRowFromUrl: () => row,
        fillAllPage3: async () => { events.push('fill'); return opts.results || ['✅ 全部字段处理完毕']; },
        saveDraft: async product => {
            events.push('saveDraft');
            if (opts.saveThrows) throw new Error('CDP 连接断开');
            return opts.saveResults || ['✅ 已保存'];
        },
        sendMessageRetry: async msg => {
            messages.push(msg);
            events.push('msg:' + msg.action);
            if (msg.action === 'getProductByRow') {
                return opts.productResp || {
                    ok: true, autoFillAllowed: true, filled: false,
                    data: { row, _publishTaskId: task, _publishFileKey: '' }
                };
            }
            if (msg.action === 'getUploadedRows') return { ok: true, rows: {} };
            if (msg.action === 'publishFilled') return { ok: true };
            return { ok: true };
        }
    };
    vm.createContext(c);
    return { c, events, logs, messages, store, removedKeys, btn, saveBtn, row, task };
}

const runIn = (env, code) => vm.runInContext(code, env.c);

// 批量路径：真实 loadBatchProduct
async function runBatch(opts = {}) {
    const env = pageEnv(opts);
    vm.runInContext([fn('waitPublishFormReady'), fn('loadBatchProduct')].join('\n'), env.c);
    await runIn(env, 'loadBatchProduct(' + env.row + ')');
    return env;
}

// 单件路径：真实「⚡ 一键填入」回调体
const ONCLICK_MARK = "document.getElementById('polo-autofill-btn').onclick = async () => {";
const ONCLICK_START = PAGE3_SRC.indexOf(ONCLICK_MARK);
const ONCLICK_END = PAGE3_SRC.indexOf('\n    };', ONCLICK_START);
const ONCLICK_BODY = (ONCLICK_START >= 0 && ONCLICK_END > ONCLICK_START)
    ? PAGE3_SRC.slice(ONCLICK_START + ONCLICK_MARK.length, ONCLICK_END) : '';

async function runSingle(opts = {}) {
    const env = pageEnv(opts);
    env.c.currentProduct = { row: env.row, _publishTaskId: env.task, _publishFileKey: '' };
    vm.runInContext('__handler = async () => {' + ONCLICK_BODY + '\n};', env.c);
    await runIn(env, '__handler()');
    return env;
}

const has = (arr, kw) => arr.some(x => String(x).includes(kw));
const logHas = (env, kw, type) => env.logs.some(l => l.m.includes(kw) && (type === undefined || l.t === type));

// ============================================================
(async () => {
    console.log('=== 页3 自动保存 / 预填标记 验收测试 ===\n');

    // ------------------------------------------------------------
    console.log('【1】填入全部成功 → 自动保存一次 → 保存成功后才 publishFilled（批量路径）');
    {
        const env = await runBatch({ results: ['✅ 标题', '✅ 属性', '✅ 全部字段处理完毕'] });
        ok(has(env.events, 'saveDraft'), '调用了 saveDraft');
        ok(env.events.filter(e => e === 'saveDraft').length === 1, `saveDraft 只调用 1 次（实际 ${env.events.filter(e => e === 'saveDraft').length}）`);
        ok(logHas(env, '✅ 已自动保存', 'success'), '日志输出「✅ 已自动保存」');
        ok(!logHas(env, '手动点击页面底部的保存按钮'), '全成功时不再提示手动保存');
        const saveAt = env.events.indexOf('saveDraft');
        const filledAt = env.events.indexOf('msg:publishFilled');
        ok(filledAt > saveAt && saveAt >= 0, `publishFilled 在 saveDraft 之后（save@${saveAt}, filled@${filledAt}）`);
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, 'publishFilled 只发 1 次');
        ok(!has(env.events, 'scroll'), '全成功时不滚动到保存按钮');
    }

    console.log('\n【1b】单件路径：全成功同样自动保存后上报');
    {
        const env = await runSingle({ results: ['✅ 标题', '✅ 全部字段处理完毕'] });
        ok(env.events.filter(e => e === 'saveDraft').length === 1, 'saveDraft 调用 1 次');
        ok(logHas(env, '✅ 已自动保存', 'success'), '日志「✅ 已自动保存」');
        const filledAt = env.events.indexOf('msg:publishFilled');
        ok(filledAt > env.events.indexOf('saveDraft'), 'publishFilled 在保存之后');
    }

    // ------------------------------------------------------------
    // 口径变更（真机反馈）：⚠️ 不再阻断自动保存，只有 ❌ 才阻断。
    console.log('【2】批量路径：有 ⚠️ → 照常自动保存，日志标注建议抽查');
    {
        const env = await runBatch({ results: ['✅ 标题', '⚠️ 属性: 2 项未填写'] });
        ok(env.events.filter(e => e === 'saveDraft').length === 1, '⚠️ 仍调用 saveDraft');
        ok(logHas(env, '已自动保存', 'success'), '日志有「已自动保存」');
        ok(logHas(env, '有警告项，已保存，建议抽查'), '日志提示含警告项');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, 'publishFilled 仍发 1 次');
    }

    console.log('【2b】单件路径：⚠️ 仍按原口径不自动保存（人在旁边，保守处理）');
    {
        const env = await runSingle({ results: ['⚠️ FAQs: 1/2 条核对正确'] });
        ok(env.events.filter(e => e === 'saveDraft').length === 0, '单件路径 saveDraft 未被调用');
        ok(logHas(env, '手动点击页面底部的保存按钮', 'warn'), '提示手动保存（warn）');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, 'publishFilled 仍发 1 次');
    }

    console.log('【2c】❌ 硬失败 → 不自动保存');
    {
        const env = await runBatch({ results: ['❌ 主图上传失败'] });
        ok(env.events.filter(e => e === 'saveDraft').length === 0, '❌ 结果不自动保存');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, '❌ 结果仍上报 publishFilled');
    }

    console.log('\n【3】saveDraft 抛异常 → 不崩、不阻断 publishFilled');
    {
        const env = await runBatch({ results: ['✅ 全部字段处理完毕'], saveThrows: true });
        ok(env.events.filter(e => e === 'saveDraft').length === 1, 'saveDraft 被调用（随后抛异常）');
        ok(logHas(env, '自动保存异常', 'warn'), '异常被 catch 并 warn');
        ok(logHas(env, 'CDP 连接断开'), 'warn 日志带上异常原因');
        ok(!logHas(env, '自动填入失败'), '没有冒泡成「自动填入失败」');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, 'publishFilled 仍然发出');
    }
    {
        const env = await runSingle({ results: ['✅ 全部字段处理完毕'], saveThrows: true });
        ok(logHas(env, '自动保存异常', 'warn'), '单件路径同样 catch 异常');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, '单件路径 publishFilled 仍然发出');
        ok(env.btn.disabled === false, '按钮恢复可用（未卡死）');
    }
    // saveDraft 返回 ⚠️（后台拒绝/找不到按钮）也不当作保存成功
    {
        const env = await runBatch({ results: ['✅ 全部字段处理完毕'], saveResults: ['⚠️ 保存按钮未点击，未标记已保存'] });
        ok(logHas(env, '自动保存未完成', 'warn'), '返回 ⚠️ 时记 warn');
        ok(!logHas(env, '✅ 已自动保存'), '返回 ⚠️ 时不记「已自动保存」');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, 'publishFilled 仍然发出');
    }

    // ------------------------------------------------------------
    console.log('\n【5】预填标记 + 队列是否已记完成 → 决定要不要补发');
    {
        const markKey = 'polo_page3_prefilled::pt_test::412';
        const env = await runBatch({
            store: [[markKey, '1']],
            productResp: { ok: true, autoFillAllowed: false, filled: true, data: { row: 412, _publishTaskId: 'pt_test', _publishFileKey: '' } }
        });
        ok(env.events.filter(e => e === 'fill').length === 0, '已填过：不重新填入');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 0, '队列已记完成 → 不补发 publishFilled（不跳行）');
        ok(env.store.get(markKey) === '1', '标记保留（不清）');
    }
    {
        const markKey = 'polo_page3_prefilled::pt_test::412';
        const env = await runBatch({
            store: [[markKey, '1']],
            productResp: { ok: true, autoFillAllowed: false, filled: false, data: { row: 412, _publishTaskId: 'pt_test', _publishFileKey: '' } }
        });
        ok(env.events.filter(e => e === 'fill').length === 0, '已填过：不重新填入');
        // 口径变更：有预填标记但没有保存记录时，不能单方面补发 publishFilled 把队列推进
        // （真机就是这么丢的行：页3 一片空白却进了下一行）。
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 0,
            '标记在但无保存记录 → 不再补发 publishFilled（不推进空行）');
    }

    // ------------------------------------------------------------
    console.log('\n【6】alreadyPrefilled && autoFillAllowed === true → 清标记后正常填入');
    {
        const markKey = 'polo_page3_prefilled::pt_test::412';
        const env = await runBatch({
            store: [[markKey, '1']],
            results: ['✅ 全部字段处理完毕'],
            productResp: { ok: true, autoFillAllowed: true, filled: false, data: { row: 412, _publishTaskId: 'pt_test', _publishFileKey: '' } }
        });
        ok(env.removedKeys.includes(markKey), '清除了本行的预填标记');
        ok(logHas(env, '该行被重新派发，已清除预填标记', 'info'), '日志说明重填派发');
        ok(env.events.filter(e => e === 'fill').length === 1, '继续走填入流程（没有提前 return）');
        ok(env.events.filter(e => e === 'saveDraft').length === 1, '重填成功后同样自动保存');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 1, '重填完成后上报 1 次');
        ok(env.store.get(markKey) === '1', '重填完成后重新写入标记');
    }

    console.log('\n【7】回归：alreadyPrefilled && autoFillAllowed === false → 仍走「已填入」分支，不重填不清标记');
    {
        const markKey = 'polo_page3_prefilled::pt_test::412';
        const env = await runBatch({
            store: [[markKey, '1']],
            productResp: { ok: true, autoFillAllowed: false, filled: true, data: { row: 412, _publishTaskId: 'pt_test', _publishFileKey: '' } }
        });
        ok(env.removedKeys.length === 0, '没有清标记');
        ok(env.events.filter(e => e === 'fill').length === 0, '没有重新填入');
        ok(env.events.filter(e => e === 'saveDraft').length === 0, '没有自动保存');
        // 提示语已按原因拆开（预填标记 / 后台不允许），断言改成命中拆开后的任一条
        ok(logHas(env, '已有预填标记') || logHas(env, '后台不允许自动填入'), '走的是「已填入」提示分支');
    }
    // 无标记 + autoFillAllowed false（队列已推进/已保存）→ 不填
    {
        const env = await runBatch({
            productResp: { ok: true, autoFillAllowed: false, filled: true, data: { row: 412, _publishTaskId: 'pt_test', _publishFileKey: '' } }
        });
        ok(env.events.filter(e => e === 'fill').length === 0, '无标记但后台不允许 → 不填入');
        ok(env.messages.filter(m => m.action === 'publishFilled').length === 0, '无标记 → 不补发通知');
    }

    // ------------------------------------------------------------
    console.log('\n【4】background getProductByRow 的 filled 标志');
    {
        const queueSrc = fs.readFileSync(path.join(root, 'tests/test-publish-queue.js'), 'utf8');
        const qc = vm.createContext({
            require, __dirname, console, setTimeout, clearTimeout, setInterval, clearInterval,
            URLSearchParams, AbortController, TextDecoder, process
        });
        vm.runInContext(queueSrc.slice(0, queueSrc.indexOf('(async function main()')), qc);
        const env = runIn({ c: qc }, 'createEnv()');
        await delay(120);

        const opened = await env.sendExternal({ action: 'openBatchPublish', rows: [412, 415], products: [{ row: 412 }, { row: 415 }] });
        ok(opened && opened.ok, '任务创建成功', JSON.stringify(opened));
        const tabId = env.store.polo_publish_task.currentTabId;
        const sender = { tab: { id: tabId, url: 'https://post.alibaba.com/product/publish?row=412&task=' + opened.taskId }, frameId: 0 };

        // 未完成、当前行 → filled:false
        let resp = await env.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: opened.taskId }, sender);
        ok(resp && resp.ok && resp.filled === false, '不在 filledRows → filled=false', resp && JSON.stringify(resp.filled));
        ok(resp.autoFillAllowed === true, '当前行未保存未填 → autoFillAllowed=true');

        // 完成 412 → 进 filledRows
        await env.sendInternal({ action: 'publishFilled', row: 412, taskId: opened.taskId },
            { tab: { id: tabId, url: sender.tab.url }, frameId: 0 });
        await delay(120);
        ok((env.store.polo_publish_task.filledRows || []).includes(412), '412 已记入 filledRows');

        resp = await env.sendInternal({ action: 'getProductByRow', rowNum: 412, taskId: opened.taskId }, sender);
        ok(resp && resp.ok && resp.filled === true, '在 filledRows → filled=true', resp && JSON.stringify(resp.filled));
        ok(resp.autoFillAllowed === false, '已完成 → autoFillAllowed=false');

        // 无 taskId 的旧路径 → filled:false
        env.store['product__row412'] = { row: 412 };
        resp = await env.sendInternal({ action: 'getProductByRow', rowNum: 412 }, { tab: { id: tabId, url: sender.tab.url }, frameId: 0 });
        ok(resp && resp.ok === true, '无 taskId 走旧路径仍返回数据');
        ok(resp.filled === false, '无 taskId 旧路径 → filled=false', JSON.stringify(resp.filled));
        ok(resp.autoFillAllowed === undefined, '旧路径不带 autoFillAllowed（不误拦自动填入）');
    }

    // ------------------------------------------------------------
    console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
    if (fail) console.log('失败项:\n - ' + failures.join('\n - '));
    // 后台沙箱里有常驻定时器，显式退出避免挂住
    process.exit(fail ? 1 : 0);
})();
