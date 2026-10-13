/* ============================================================================
 * 套图（快速五图）任务生命周期
 *
 * 与换色任务（color 命名空间）完全隔离：独立的存储键、独立的消息动作前缀、
 * 独立的阶段机。两者共用豆包标签/输入通道，因此由本模块提供互斥排队。
 *
 * 阶段（只单向推进）：
 *   received    消息已接收、参数已校验（尚未发往豆包）
 *   sent        提示词与素材已提交给豆包
 *   acquired    已取回 5 张有效且互不相同的结果
 *   saved       5 张最终文件已写入授权目录并逐一校验通过
 *   completed   任务完成（仅 saved 之后才能到达）
 *   失败/中断：failed / interrupted（终态，不回退）
 *
 * 约束：
 *  - 收到消息 ≠ 成功；只有 saved 之后才允许 completed。
 *  - 任何进度/结果回传都必须携带任务身份（taskId+fileKey+rowNum），
 *    身份不符、已取消或阶段倒退的回传一律拒绝。
 *  - MV3 后台会休眠：状态全部持久化在 storage，启动时把非终态任务标记为
 *    interrupted，绝不自动重发已经提交的豆包请求。
 * ========================================================================== */
'use strict';

const SuiteTaskStore = (() => {
    const KEY = 'suite_tasks_v1';
    const MAX_KEEP = 60;                        // 只保留最近的任务，避免无限增长
    const STAGES = ['received', 'sent', 'acquired', 'saved', 'completed'];
    const TERMINAL = ['completed', 'failed', 'interrupted'];

    // 合法模式：快速五图 / 指定单张重生成
    const MODES = ['quick-five', 'single-regen'];

    let cache = null;                           // 内存缓存（可随时从 storage 重建）

    function isTerminal(stage) { return TERMINAL.indexOf(stage) >= 0; }
    function stageIndex(stage) { return STAGES.indexOf(stage); }

    function normalizeKey(fileKey) {
        // fileKey 允许为空字符串（未设置文件名）；null/undefined 统一为空串
        return (fileKey === undefined || fileKey === null) ? '' : String(fileKey);
    }

    function readAll() {
        return new Promise((resolve) => {
            if (cache) { resolve(cache); return; }
            chrome.storage.local.get(KEY, (r) => {
                const v = r && r[KEY];
                cache = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
                resolve(cache);
            });
        });
    }

    function writeAll(all) {
        cache = all;
        return new Promise((resolve) => chrome.storage.local.set({ [KEY]: all }, resolve));
    }

    function prune(all) {
        const ids = Object.keys(all);
        if (ids.length <= MAX_KEEP) return all;
        ids.sort((a, b) => (all[a].startedAt || 0) - (all[b].startedAt || 0));
        for (const id of ids.slice(0, ids.length - MAX_KEEP)) delete all[id];
        return all;
    }

    // 同一「文件+行号+模式」只允许一个未完成任务：防双击/重复消息触发两次生成
    async function activeFor({ fileKey, rowNum, mode }) {
        const all = await readAll();
        const fk = normalizeKey(fileKey);
        return Object.values(all).find(t =>
            !isTerminal(t.stage) && t.fileKey === fk && t.rowNum === rowNum && t.mode === mode) || null;
    }

    async function create({ fileKey, rowNum, productId, mode, targetKeys, configSnapshot, assets, expectCount, prompt }) {
        const fk = normalizeKey(fileKey);
        if (MODES.indexOf(mode) < 0) throw new Error(`未知套图模式：${mode || '(空)'}`);
        if (!Number.isInteger(rowNum) || rowNum <= 0) throw new Error('套图任务缺少有效的产品行号');
        if (!Array.isArray(targetKeys) || targetKeys.length === 0) throw new Error('套图任务缺少目标输出编号');
        if (mode === 'quick-five') {
            if (expectCount !== 5) throw new Error('快速五图任务的 expectCount 必须为 5');
            if (targetKeys.length !== 5) throw new Error('快速五图必须配置 5 个输出编号');
        } else if (mode === 'single-regen') {
            if (expectCount !== 1) throw new Error('指定单张重生成的 expectCount 必须为 1');
            if (targetKeys.length !== 1) throw new Error('指定单张重生成必须且只能指定 1 个输出编号');
        }

        const dup = await activeFor({ fileKey: fk, rowNum, mode });
        if (dup) throw new Error(`已有未完成的同类任务（${dup.taskId}，阶段 ${dup.stage}），拒绝重复发起`);

        const all = await readAll();
        const taskId = 'suite_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const task = {
            taskId, fileKey: fk, rowNum,
            productId: (productId === undefined || productId === null) ? rowNum : productId,
            mode, expectCount, targetKeys: targetKeys.map(k => String(k).trim()),
            stage: 'received',
            startedAt: Date.now(),
            updatedAt: Date.now(),
            stageAt: { received: Date.now() },
            // 配置快照 + 素材对应关系：运行中用户改配置/切产品不影响本任务
            configSnapshot: configSnapshot ? JSON.parse(JSON.stringify(configSnapshot)) : null,
            assets: Array.isArray(assets) ? assets.map(a => ({ color: a.color, filename: a.filename, fileKey: a.fileKey, row: a.row, bytes: a.bytes, width: a.width, height: a.height })) : [],
            promptLength: prompt ? String(prompt).length : 0,
            results: [],        // [{ key, saved: bool, path, bytes, error }]
            error: '',          // 失败/中断原因（含具体阶段）
            diag: []            // 诊断信息（失败时保留，便于定位）
        };
        all[taskId] = task;
        await writeAll(prune(all));
        return JSON.parse(JSON.stringify(task));
    }

    async function get(taskId) {
        const all = await readAll();
        return all[taskId] ? JSON.parse(JSON.stringify(all[taskId])) : null;
    }

    async function list(filter = {}) {
        const all = await readAll();
        let out = Object.values(all);
        if (filter.fileKey !== undefined) out = out.filter(t => t.fileKey === normalizeKey(filter.fileKey));
        if (filter.rowNum !== undefined) out = out.filter(t => t.rowNum === filter.rowNum);
        if (filter.activeOnly) out = out.filter(t => !isTerminal(t.stage));
        out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        return JSON.parse(JSON.stringify(out));
    }

    // 阶段推进：只允许向前；saved 之前不允许 completed
    async function advance(taskId, stage, patch = {}) {
        const all = await readAll();
        const t = all[taskId];
        if (!t) throw new Error(`任务不存在：${taskId}`);
        if (isTerminal(t.stage)) throw new Error(`任务已处于终态（${t.stage}），不能再推进`);
        const from = stageIndex(t.stage), to = stageIndex(stage);
        if (to < 0) throw new Error(`未知阶段：${stage}`);
        if (to <= from) throw new Error(`阶段不能回退（${t.stage} → ${stage}）`);
        if (stage === 'completed' && stageIndex(t.stage) < stageIndex('saved')) {
            throw new Error('未保存成功不允许标记完成');
        }
        t.stage = stage;
        t.updatedAt = Date.now();
        t.stageAt[stage] = Date.now();
        Object.assign(t, patch);
        await writeAll(all);
        return JSON.parse(JSON.stringify(t));
    }

    async function finish(taskId, stage, error, patch = {}) {
        const all = await readAll();
        const t = all[taskId];
        if (!t) throw new Error(`任务不存在：${taskId}`);
        if (isTerminal(t.stage)) throw new Error(`任务已处于终态（${t.stage}），不能再结束`);
        if (TERMINAL.indexOf(stage) < 0) throw new Error(`非终态阶段：${stage}`);
        t.stage = stage;
        t.error = error || '';
        t.updatedAt = Date.now();
        t.stageAt[stage] = Date.now();
        Object.assign(t, patch);
        await writeAll(all);
        return JSON.parse(JSON.stringify(t));
    }

    const fail = (taskId, error, patch) => finish(taskId, 'failed', error, patch);
    const interrupt = (taskId, error, patch) => finish(taskId, 'interrupted', error, patch);

    async function cancel(taskId, reason) {
        const all = await readAll();
        const t = all[taskId];
        if (!t) throw new Error(`任务不存在：${taskId}`);
        if (isTerminal(t.stage)) return JSON.parse(JSON.stringify(t));
        t.cancelled = true;
        t.cancelledAt = Date.now();
        t.stage = 'interrupted';
        t.error = reason || '用户取消';
        t.stageAt.interrupted = Date.now();
        t.updatedAt = Date.now();
        await writeAll(all);
        return JSON.parse(JSON.stringify(t));
    }

    /* 身份核验：所有进度/结果回传都必须先过这里。
       拒绝：任务不存在 / 身份不符 / 已取消 / 已终态 / 阶段倒退 */
    async function acceptReport(report) {
        const { taskId, fileKey, rowNum, stage } = report || {};
        const all = await readAll();
        const t = all[taskId];
        if (!t) return { accepted: false, reason: `未知任务：${taskId || '(空)'}` };
        if (t.cancelled) return { accepted: false, reason: '任务已取消，拒绝迟到结果' };
        if (normalizeKey(fileKey) !== t.fileKey || rowNum !== t.rowNum) {
            return { accepted: false, reason: `任务身份不符（收到 ${normalizeKey(fileKey)}/row${rowNum}，期望 ${t.fileKey}/row${t.rowNum}）` };
        }
        if (isTerminal(t.stage)) return { accepted: false, reason: `任务已终态（${t.stage}），拒绝迟到结果` };
        if (stage && stageIndex(stage) >= 0 && stageIndex(stage) < stageIndex(t.stage)) {
            return { accepted: false, reason: `阶段倒退（当前 ${t.stage}，收到 ${stage}）` };
        }
        return { accepted: true, task: JSON.parse(JSON.stringify(t)) };
    }

    // MV3 冷启动恢复：非终态任务标记为中断（不自动重发豆包请求）
    async function recoverOnStartup() {
        const all = await readAll();
        const interrupted = [];
        for (const id of Object.keys(all)) {
            const t = all[id];
            if (isTerminal(t.stage)) continue;
            t.stage = 'interrupted';
            t.error = `后台休眠/重载导致执行上下文丢失（中断于 ${t.stage}）`;
            t.updatedAt = Date.now();
            t.stageAt.interrupted = Date.now();
            interrupted.push(id);
        }
        if (interrupted.length) await writeAll(all);
        return interrupted;
    }

    // 清空测试/调试用
    async function reset() { await writeAll({}); }

    return {
        KEY, STAGES, TERMINAL, MODES,
        create, get, list, activeFor, advance, fail, interrupt, cancel,
        acceptReport, recoverOnStartup, reset, isTerminal
    };
})();

if (typeof globalThis !== 'undefined') globalThis.SuiteTaskStore = SuiteTaskStore;
