/* 原保存/检查/补缺的适配层；sessionStorage 使平台保存重载后仍能继续。
 * 只有明确任务入口才能开始新一轮；普通页面加载只恢复已有进度。
 */
(() => {
    'use strict';
    let busy = false;
    const identity = p => JSON.stringify([p?._publishTaskId || '', p?._publishFileKey ?? '', Number(p?.row)]);
    const key = p => 'polo_save_review::' + identity(p);
    const itemId = () => new URLSearchParams(location.search).get('itemId') || '';
    const read = p => {
        const raw = sessionStorage.getItem(key(p));
        return raw ? JSON.parse(raw) : null;
    };
    function proof(product) {
        const stored = read(product);
        return stored?.state?.phase === 'complete'
            ? { cycleId: stored.state.cycleId, attempt: stored.state.attempt } : null;
    }
    async function run(product, options) {
        if (busy) throw Error('保存复查正在运行');
        if (!window.PoloSaveReviewCycle || !window.PoloPage3Review) throw Error('保存复查模块未加载');
        let stored = read(product);
        let fresh = !stored;
        if (!stored && options.resumeOnly) return null;
        if (!stored && !product?._publishTaskId && !options.allowManual) throw Error('缺少自动保存任务身份');
        const owner = identity(product), originalProduct = product;
        const current = () => options.getProduct() === originalProduct && identity(options.getProduct()) === owner
            && (!stored?.itemId || stored.itemId === itemId());
        if (!current()) throw Error('商品身份已变化，停止保存复查');
        busy = true;
        try {
            if (options.startNew && stored?.state?.phase === 'complete') { stored = null; fresh = true; }
            if (!stored) stored = { state: window.PoloSaveReviewCycle.create(owner), itemId: itemId() };
            const report = (label, row) => options.log(`${label}：${row.detail}`, row.state === 'pass' ? 'info' : 'warn');
            const evidence = async wanted => {
                // 新文档可能早于后台核验结束；只轮询读取，不重发保存。
                for (let i = 0; i < 20; i++) {
                    if (!current()) throw Error('商品身份已变化');
                    const response = await options.send({ action: 'getUploadedRows', taskId: product._publishTaskId, fileKey: product._publishFileKey });
                    const row = response?.ok && response.rows?.[product.row];
                    if (row?.reviewCycleId === wanted.cycleId && row.reviewAttempt === wanted.attempt) {
                        if (!row.itemId || row.itemId !== itemId()) return null;
                        return { verified: row.verified === true, cycleId: row.reviewCycleId, attempt: row.reviewAttempt };
                    }
                    await options.wait(500);
                }
                return null;
            };
            const persist = async state => {
                if (!current()) throw Error('商品身份已变化');
                stored = { state, itemId: stored.itemId || itemId() };
                sessionStorage.setItem(key(product), JSON.stringify(stored));
                if (!current()) throw Error('商品身份已变化');
            };
            const adapter = {
                identity: () => current() ? owner : '',
                write: persist,
                save: async token => {
                    options.log(token.attempt === 1 ? '正在首次保存；保存刷新后自动检查' : '缺项已补，正在再次保存；刷新后重新检查', 'info');
                    const results = await options.save(product, { reviewCycle: token });
                    if (!Array.isArray(results) || !results.length || results.some(r => /^[⚠️❌]/u.test(String(r).trim()))) {
                        return { verified: false };
                    }
                    // 平台必须重新读取保存内容。旧文档不凭当前DOM声明保存后复查成功。
                    // 正常保存会卸载本上下文，新文档从saving恢复；未重载则停下而不重复保存。
                    await options.wait(8000);
                    return { verified: false, unconfirmed: true };
                },
                savedEvidence: evidence,
                inspect: async () => {
                    options.log('正在检查实际内容；已有内容保留，不按质量分重填', 'info');
                    const checks = window.PoloPage3Review.checks(product);
                    const rows = await window.PoloPage3Review.run(checks, null, report, { readOnly: true, isCurrent: current });
                    return rows.map((row, index) => ({ ...row.after, action: checks[index].action }));
                },
                repair: async actions => {
                    options.log(`仅补缺失项目（${actions.length}项），不执行整页填入`, 'info');
                    const checks = window.PoloPage3Review.checks(product).filter(c => actions.includes(c.action));
                    const rows = await window.PoloPage3Review.run(checks, action => options.repair(product, action), report,
                        { readOnly: false, isCurrent: current });
                    if (rows.some(row => row.after.state !== 'pass')) throw Error('缺失项补填未确认，保留当前内容，不继续保存');
                }
            };
            if (fresh) {
                // 原上传失败可能使必填项为空，先走同一补缺器，避免平台拒绝首次保存。
                let rows = await adapter.inspect();
                if (rows.some(r => r.state === 'unknown')) {
                    await persist({ ...stored.state, phase: 'blocked', reason: '保存前有无法安全判断的项目' });
                } else if (rows.some(r => r.state === 'fail')) {
                    await persist({ ...stored.state, phase: 'repairing', repairs: 1 });
                    await adapter.repair(rows.filter(r => r.state === 'fail').map(r => r.action));
                    rows = await adapter.inspect();
                    await persist({ ...stored.state, phase: rows.length && rows.every(r => r.state === 'pass') ? 'ready' : 'blocked',
                        reason: '保存前补缺仍未通过，不提交不完整内容' });
                } else if (!rows.length) {
                    await persist({ ...stored.state, phase: 'blocked', reason: '保存前检查结果为空' });
                }
            }
            for (let i = 0; i < 4; i++) {
                const state = await window.PoloSaveReviewCycle.step(stored.state, adapter);
                if (state.phase === 'blocked') {
                    options.log('保存后复查已停止：' + state.reason + '；不推进队列', 'warn');
                    if (options.hold) await options.hold(state.reason);
                    return state;
                }
                if (state.phase === 'complete') {
                    if (options.refreshQuality) await options.refreshQuality();
                    if (!current()) throw Error('商品身份已变化，停止确认复查');
                    // 质量检测有异步等待；等待期间的改动不能沿用此前complete放行。
                    const finalRows = await adapter.inspect();
                    if (!finalRows.length || finalRows.some(row => row.state !== 'pass')) {
                        await persist({ ...state, phase: 'reviewing' });
                        throw Error('最终放行检查未通过，保留当前商品，不推进队列');
                    }
                    const response = await options.send({ action: 'finishPublishReview', row: product.row,
                        taskId: product._publishTaskId, fileKey: product._publishFileKey,
                        itemId: itemId(), cycleId: state.cycleId, attempt: state.attempt });
                    if (!response?.ok) throw Error(response?.error || '后台未确认复查结果');
                    options.log('保存后的各项复查通过，后台已确认', 'success');
                    return state;
                }
            }
            throw Error('保存复查步骤超限，停止自动处理');
        } catch (error) {
            if (options.hold) {
                try { await options.hold(error.message); } catch (_) {}
            }
            throw error;
        } finally { busy = false; }
    }
    window.PoloSaveReviewRuntime = { run, proof, has: product => !!read(product), get busy() { return busy; } };
})();
