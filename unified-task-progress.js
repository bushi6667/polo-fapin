// 两条独立进度条：生图（换色/套图）与发品（批量发品），按钮互不混用。
(() => {
    const host = document.querySelector('.detail-column'); if (!host) return;
    const style = document.createElement('style');
    style.textContent = '#batchColorProgress,#batchPublishProgress,#suiteGlobalProgress,#suiteAutoControls{display:none!important}.unified-actions{display:flex;gap:8px;flex-wrap:wrap}';
    document.head.append(style);

    const text = id => document.getElementById(id)?.textContent || '';
    const makePanel = id => {
        const panel = document.createElement('div');
        panel.id = id; panel.className = 'task-progress';
        panel.innerHTML = '<div class="progress-header"><span role="status" aria-live="polite"></span><div class="unified-actions"></div></div><div class="progress-bar"><div class="progress-fill"></div></div><div class="progress-text"><span></span><span></span></div>';
        const controls = document.createElement('div'); controls.className = 'progress-recycle-controls';
        const bar = document.createElement('button'); bar.type = 'button'; bar.className = 'progress-recycle-bar';
        bar.setAttribute('aria-label', '展开回收箭头'); bar.setAttribute('aria-expanded', 'false'); bar.title = '点击展开回收箭头';
        const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'progress-recycle-arrow'; arrow.textContent = '〈';
        arrow.setAttribute('aria-label', '回收此进度'); arrow.title = '回收此进度，结束当前任务'; arrow.tabIndex = -1; arrow.setAttribute('aria-hidden', 'true');
        controls.append(bar, arrow); panel.append(controls);
        const api = { panel, controls, bar, arrow, recycled: false, signature: '', kind: () => '' };
        const setOpen = open => { controls.classList.toggle('is-open', open); panel.classList.toggle('progress-recycle-open', open); bar.setAttribute('aria-expanded', String(open)); arrow.tabIndex = open ? 0 : -1; arrow.setAttribute('aria-hidden', String(!open)); };
        bar.onclick = event => { event.stopPropagation(); setOpen(!controls.classList.contains('is-open')); };
        document.addEventListener('click', event => { if (!controls.contains(event.target)) setOpen(false); });
        controls.onkeydown = event => { if (event.key === 'Escape') { setOpen(false); bar.focus(); } };
        arrow.onclick = async event => {
            event.stopPropagation(); if (api.recycled || !controls.classList.contains('is-open')) return;
            api.recycled = true; bar.disabled = arrow.disabled = true;
            const kind = api.kind();
            try { if (kind && typeof window.PoloRecycleTask === 'function') await window.PoloRecycleTask(kind); } catch (_) {}
            const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!reduced && panel.animate) { try { await panel.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-18px)' }], { duration: 300, easing: 'ease-out' }).finished; } catch (_) {} }
            panel.style.display = 'none';
        };
        host.prepend(panel);
        return api;
    };

    const image = makePanel('imageTaskProgress');
    const publish = makePanel('publishTaskProgress');
    host.prepend(image.panel);

    const reset = api => { api.recycled = false; api.signature = ''; api.bar.disabled = api.arrow.disabled = false; };
    window.UnifiedTaskStarted = () => reset(image);

    function update(api, title, done, total, current, actions) {
        const next = JSON.stringify([title, done, total, current, actions.map(a => [a[0], a[2]])]); if (next === api.signature) return; api.signature = next;
        api.panel.style.display = title ? 'block' : 'none';
        api.panel.querySelector('[role=status]').textContent = title;
        api.panel.querySelector('.progress-fill').style.width = (total ? Math.min(100, done / total * 100) : 0) + '%';
        const counters = api.panel.querySelector('.progress-text').children; counters[0].textContent = (total ? done + '/' + total : done + '/-'); counters[1].textContent = current;
        const buttons = api.panel.querySelector('.unified-actions'); buttons.replaceChildren();
        for (const [label, click, disabled] of actions) { const button = document.createElement('button'); button.className = 'stop-btn'; button.textContent = label; button.disabled = !!disabled; button.onclick = click; buttons.append(button); }
    }

    const suiteState = () => { try { return typeof readSuiteAutoState === 'function' ? readSuiteAutoState() : null; } catch (_) { return null; } };
    const colorState = () => { try { return typeof batchColorState !== 'undefined' ? batchColorState : null; } catch (_) { return null; } };
    const colorResumeCount = () => { try { return typeof getColorResumeRows === 'function' ? getColorResumeRows().length : 0; } catch (_) { return 0; } };
    const batchState = () => { try { return typeof suiteBatchState !== 'undefined' ? suiteBatchState : null; } catch (_) { return null; } };
    const batchRunning = () => { try { return typeof suiteBatchRunning !== 'undefined' ? suiteBatchRunning : false; } catch (_) { return false; } };

    const compressState = () => { try { return window.SuiteCompressState || null; } catch (_) { return null; } };

    function imageKind() {
        const suite = suiteState(), color = colorState(), batch = batchState();
        const comp = compressState();
        if (comp && comp.running) return 'compress';
        if (color && color.running) return 'color';
        if (batch && !batch.completed && batchRunning()) return 'suiteBatch';
        if (suite && suite.phase !== 'completed' && typeof suiteTaskRunning !== 'undefined' && suiteTaskRunning) return 'suite';
        if (color && !color.running && colorResumeCount() > 0) return 'color';
        if (suite && suite.phase !== 'completed') return 'suite';
        if (batch && !batch.completed) return 'suiteBatch';
        return '';
    }

    function renderImage() {
        if (image.recycled) { image.panel.style.display = 'none'; if (!imageKind()) reset(image); return; }
        const kind = imageKind(), suite = suiteState(), color = colorState();
        let title = '', done = 0, total = 0, current = ''; const actions = [];
        if (kind === 'compress') {
            const comp = compressState() || {};
            title = '压缩图片 · ' + (comp.cancel ? '正在停止' : '进行中');
            done = comp.done || 0; total = comp.total || 0; current = comp.current || '';
            actions.push(['⏹ 停止', () => { try { window.SuiteCompressState.cancel = true; } catch (_) {} }]);
        } else if (kind === 'color' && color && color.running) {
            title = text('batchColorStatus') || '换色中';
            done = color.currentIndex || 0; total = color.queue?.length || 0; current = text('batchColorCurrent');
            actions.push(['⏸ 暂停', () => stopBatchColorChange()]);
        } else if (kind === 'color' && color) {
            title = '换色 · 已暂停';
            done = color.currentIndex || 0; total = color.queue?.length || 0;
            current = '从 row' + (color.queue?.[color.currentIndex]?.row || '') + ' 继续';
            actions.push(['▶ 继续', () => resumeColorBatch()]);
        } else if (kind === 'suiteBatch') {
            const batch = batchState(), running = batchRunning();
            title = '连续生成套图 · ' + (batch.paused || !running ? '已暂停' : '运行中');
            done = batch.index || 0; total = (batch.rows && batch.rows.length) || 0; current = '行' + batch.rows[batch.index];
            actions.push([batch.paused || !running ? '▶ 继续' : '⏸ 暂停', () => toggleSuiteBatch()]);
        } else if (kind === 'suite' && suite) {
            // 分母兜底：state.total 缺失时，指定重生成按 1 张算，整套才按 5 张（旧数据写死 5 会误导）
            const suiteGoal = () => Number(suite.total) || ((typeof targetedRegenerationRunning !== 'undefined' && targetedRegenerationRunning) ? 1 : 5);
            const labels = { preparing: '准备中', generating: '生成中', processing: '后处理中', saving: '保存中', error: '未完成' };
            const targeted = typeof targetedRegenerationRunning !== 'undefined' && targetedRegenerationRunning;
            // 统一按「套」计数：只要这一行属于未完成的连续队列，就算套数（暂停/运行都一样），
            // 套内第几张只放在文字里，不参与进度数字。
            const batch = batchState();
            const inBatch = !!(batch && !batch.completed && batch.rows && batch.rows[batch.index] === suite.rowNum);
            if (inBatch) {
                title = '连续生成套图 · ' + (suite.paused ? '已暂停' : (labels[suite.phase] || '未完成'));
                done = batch.index || 0; total = (batch.rows && batch.rows.length) || 0;
                current = '行' + suite.rowNum + '（本套 ' + (suite.done || 0) + '/' + suiteGoal() + '）';
            } else {
                title = (targeted ? '指定重生成' : '套图') + ' · ' + (suite.paused ? '已暂停' : (labels[suite.phase] || '未完成'));
                // 单品也是一套：进行中 0/1，结束 1/1
                done = (suite.phase === 'completed' || (!suite.paused && suite.phase === 'saving')) ? 1 : 0;
                total = 1;
                current = '行' + suite.rowNum + '（本套 ' + (suite.done || 0) + '/' + suiteGoal() + '）' + (suite.currentKey ? ' · ' + suite.currentKey : '');
            }
            const relevant = suite.fileKey === currentFileKey() && suite.rowNum === currentProduct?.row;
            if (relevant) actions.push([suite.paused ? '▶ 继续' : '⏸ 暂停', () => toggleSuiteAuto()]);
            else actions.push(['查看任务', () => { document.querySelector('#suiteGlobalProgress button')?.click(); }]);
        }
        update(image, title, done, total, current, actions);
    }

    let publishImage = null;
    window.UnifiedPublishProgress = state => {
        if (state.fileKey && state.fileKey !== currentFileKey()) return;
        publishImage = state.phase === 'idle' ? null : { ...state, at: Date.now() };
        reset(publish); renderPublish();
    };
    const publishState = () => { try { return typeof lastPublishState !== 'undefined' ? lastPublishState : null; } catch (_) { return null; } };
    function publishKind() {
        const pub = publishState();
        if (publishImage && Date.now() - publishImage.at < 120000 && publishImage.phase !== 'completed') return 'publishImage';
        if (pub && pub.state !== 'idle') return 'publish';
        return '';
    }
    function renderPublish() {
        if (publish.recycled) { publish.panel.style.display = 'none'; if (!publishKind()) reset(publish); return; }
        const pub = publishState();
        let title = '', done = 0, total = 0, current = ''; const actions = [];
        if (publishImage && Date.now() - publishImage.at < 120000 && publishImage.phase !== 'completed') {
            title = '批量发品 · ' + ({ preparing: '正在准备图片', compressing: '正在压缩图片', uploading: '正在上传图片', error: '图片处理失败' }[publishImage.phase] || '处理中');
            done = publishImage.done || 0; total = publishImage.total || 0; current = publishImage.rowNum ? '行' + publishImage.rowNum : '';
            if (pub && pub.state !== 'idle' && pub.state !== 'done') actions.push([pub.state === 'running' ? '⏸ 暂停' : '▶ 继续', () => togglePublishRun()]);
        } else if (pub && pub.state !== 'idle') {
            title = text('batchPublishStatus'); done = pub.filledCount || 0; total = pub.total || 0;
            current = pub.state === 'running' ? text('batchPublishCurrent')
                : [text('batchPublishCurrent'), text('batchPublishBatch'), text('batchPublishPending'), text('batchPublishPause')].filter(Boolean).join(' · ');
            if (pub.state !== 'done') actions.push([pub.state === 'running' ? '⏸ 暂停' : '▶ 继续', () => togglePublishRun()]);
        }
        update(publish, title, done, total, current, actions);
    }

    image.kind = imageKind;
    publish.kind = publishKind;
    renderImage(); renderPublish();
    setInterval(() => { renderImage(); renderPublish(); }, 300);
})();