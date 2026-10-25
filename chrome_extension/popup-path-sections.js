// 填写与授权是两种状态：折叠标题只表示是否保存了配置，不冒充权限仍有效。
(() => {
    let revision = 0;
    function render(kind, filled) {
        const label = document.getElementById(kind + '-filled');
        label.textContent = filled ? '已填写' : '未填写';
        label.classList.toggle('is-empty', !filled);
    }
    async function refresh() {
        const current = ++revision;
        try {
            const [config, ps, scripts] = await Promise.all([
                chrome.storage.local.get(['polo_helper_path','polo_color_img_dir']),
                PoloDirectories.get(),
                PoloDirectories.pickerRecord('js-directory')
            ]);
            if (current !== revision) return;
            render('helper', !!config.polo_helper_path);
            render('color', !!config.polo_color_img_dir);
            render('ps', !!ps);
            render('scripts', !!scripts?.handle);
        } catch (error) { console.warn('读取配置填写状态失败',error); }
    }
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.polo_helper_path || changes.polo_color_img_dir)) refresh();
    });
    window.addEventListener('polo-directory-saved', refresh);
    refresh();
})();
