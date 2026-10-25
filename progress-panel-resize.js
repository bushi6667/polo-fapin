/* Recycle only the progress UI; task data and execution are untouched. */
(() => {
    const key = 'polo_recycled_progress_panels_v1';
    let recycled = [];
    try { const value = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(value)) recycled = value; } catch (_) {}
    document.querySelector('.progress-panel-restore')?.remove();
    for (const id of ['batchColorProgress', 'batchPublishProgress']) {
        const panel = document.getElementById(id);
        if (!panel) continue;
        if (recycled.includes(id)) { panel.remove(); continue; }
        panel.style.removeProperty('width');
        delete panel.dataset.progressCollapsed;
        panel.querySelector('.progress-panel-resizer')?.remove();
        const controls = document.createElement('div');
        controls.className = 'progress-recycle-controls';
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'progress-recycle-bar';
        bar.setAttribute('aria-label', '展开进度回收箭头');
        bar.setAttribute('aria-expanded', 'false');
        bar.title = '点击展开回收箭头';
        const arrow = document.createElement('button');
        arrow.type = 'button';
        arrow.className = 'progress-recycle-arrow';
        arrow.textContent = '〈';
        arrow.setAttribute('aria-label', '回收此进度');
        arrow.title = '回收此进度，不再显示';
        arrow.tabIndex = -1;
        arrow.setAttribute('aria-hidden', 'true');
        controls.append(bar, arrow);
        panel.append(controls);
        const setOpen = open => {
            controls.classList.toggle('is-open', open);
            panel.classList.toggle('progress-recycle-open', open);
            bar.setAttribute('aria-expanded', String(open));
            arrow.tabIndex = open ? 0 : -1;
            arrow.setAttribute('aria-hidden', String(!open));
        };
        bar.addEventListener('click', event => {
            event.stopPropagation();
            setOpen(!controls.classList.contains('is-open'));
        });
        const outside = event => { if (!controls.contains(event.target)) setOpen(false); };
        document.addEventListener('click', outside);
        controls.addEventListener('keydown', event => {
            if (event.key === 'Escape') { setOpen(false); bar.focus(); }
        });
        let removing = false;
        arrow.addEventListener('click', async event => {
            event.stopPropagation();
            if (removing || !controls.classList.contains('is-open')) return;
            try {
                const latest = JSON.parse(localStorage.getItem(key) || '[]');
                recycled = [...new Set([...(Array.isArray(latest) ? latest : []), id])];
                localStorage.setItem(key, JSON.stringify(recycled));
            } catch (_) {
                if (typeof showToast === 'function') showToast('回收状态保存失败，请稍后重试');
                return;
            }
            removing = true;
            bar.disabled = arrow.disabled = true;
            panel.classList.add('progress-recycling');
            const rect = panel.getBoundingClientRect();
            const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            try {
                const animation = panel.animate([
                    { width: rect.width + 'px', height: rect.height + 'px', opacity: 1, transform: 'translateX(0)' },
                    { width: '0px', height: '0px', padding: '0px', borderWidth: '0px', opacity: 0, transform: 'translateX(-18px)' }
                ], { duration: reduced ? 0 : 360, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
                await Promise.race([animation.finished, new Promise(resolve => setTimeout(resolve, 450))]);
            } finally {
                document.removeEventListener('click', outside);
                panel.remove();
            }
        });
    }
})();
