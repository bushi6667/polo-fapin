/* 保存后复查控制器。存储、页面读取和原补缺函数由适配器提供。
 * 保存前必须持久化 saving；保存可能卸载页面，恢复时不得盲目重发。
 * 此模块不会自行点击保存、重载页面或推进队列。
 */
(() => {
    'use strict';
    const phases = new Set(['ready', 'saving', 'reviewing', 'repairing', 'complete', 'blocked']);
    function create(identity, maxRepairs = 2) {
        if (!identity || typeof identity !== 'string') throw Error('缺少商品任务身份');
        if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) throw Error('补缺轮数无效');
        const cycleId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return { version: 1, identity, cycleId, phase: 'ready', repairs: 0, maxRepairs, attempt: 0 };
    }
    function validate(state) {
        if (!state || state.version !== 1 || typeof state.identity !== 'string' || !state.identity
            || typeof state.cycleId !== 'string' || !state.cycleId || !phases.has(state.phase)
            || !Number.isInteger(state.repairs) || !Number.isInteger(state.maxRepairs)
            || state.repairs < 0 || state.maxRepairs < 0 || state.maxRepairs > 5
            || state.repairs > state.maxRepairs || !Number.isInteger(state.attempt) || state.attempt < 0) {
            throw Error('保存复查进度无效，停止自动处理');
        }
    }
    async function step(saved, adapter) {
        validate(saved);
        let state = { ...saved };
        const current = () => {
            if (adapter.identity() !== state.identity) throw Error('当前商品或任务已切换');
        };
        const persist = async patch => {
            current();
            state = { ...state, ...patch };
            await adapter.write({ ...state });
            current();
        };
        const block = reason => persist({ phase: 'blocked', reason });
        current();
        // complete 是可重复读取的最终证据；实际队列确认需另有幂等身份闸门。
        if (state.phase === 'complete' || state.phase === 'blocked') return state;
        if (state.phase === 'repairing') {
            await block('补缺过程曾中断；先只检查当前内容，不自动重放补缺');
            return state;
        }
        if (state.phase === 'ready') {
            await persist({ phase: 'saving', attempt: state.attempt + 1 });
            let response;
            try { response = await adapter.save({ cycleId: state.cycleId, attempt: state.attempt }); }
            catch (_) { await block('保存响应异常，结果未确认，不自动重发'); return state; }
            current();
            if (!response || response.verified !== true || response.unconfirmed || response.incomplete) {
                await block('保存结果未确认，不自动重发');
                return state;
            }
            await persist({ phase: 'reviewing' });
        } else if (state.phase === 'saving') {
            // 恢复页只能依赖对应本次尝试的后台保存证据，不能拿旧保存记录替代。
            const evidence = await adapter.savedEvidence({ cycleId: state.cycleId, attempt: state.attempt });
            current();
            if (!evidence || evidence.verified !== true || evidence.cycleId !== state.cycleId || evidence.attempt !== state.attempt) {
                await block('页面已恢复，但本次保存证据未确认；不自动重发');
                return state;
            }
            await persist({ phase: 'reviewing' });
        }
        const rows = await adapter.inspect();
        current();
        if (!Array.isArray(rows) || !rows.length || rows.some(r => !r || !['pass', 'fail', 'unknown'].includes(r.state))) {
            await block('检查结果不完整');
        } else if (rows.some(r => r.state === 'unknown')) {
            await block('存在无法安全判断的项目，保留现有内容');
        } else if (rows.every(r => r.state === 'pass')) {
            await persist({ phase: 'complete' });
        } else if (state.repairs >= state.maxRepairs) {
            await block('已到补缺轮数上限，停止重复处理');
        } else {
            const missing = rows.filter(r => r.state === 'fail');
            if (missing.some(r => typeof r.action !== 'string' || !r.action)) {
                await block('缺失项没有安全补缺入口');
            } else {
                await persist({ phase: 'repairing', repairs: state.repairs + 1 });
                try {
                    // 适配器须沿用现有补缺器的二次读数保护，不能调用整页填入。
                    await adapter.repair([...new Set(missing.map(r => r.action))]);
                    current();
                    await persist({ phase: 'ready' });
                } catch (_) {
                    current();
                    await block('补缺中断，保留现有内容，停止自动保存');
                }
            }
        }
        return state;
    }
    globalThis.PoloSaveReviewCycle = { create, step };
})();
