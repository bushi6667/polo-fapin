// 选择只更新待保存项；点击保存后才切换后台使用的目录。
(() => {
    const status = document.getElementById('ps-directory-status');
    const input = document.getElementById('ps-directory');
    const choose = document.getElementById('choose-ps-directory');
    const save = document.getElementById('save-ps-directory');
    const history = document.getElementById('ps-directory-history');
    let selected = null;
    let savedDirectory = null;
    let entries = [];
    let busy = false;

    function setBusy(value) {
        busy = value;
        choose.disabled = history.disabled = value;
        save.disabled = value || !selected;
    }

    async function renderHistory() {
        entries = await PoloDirectories.history();
        history.replaceChildren(new Option('曾经用过...', ''));
        entries.forEach((entry, index) => history.add(new Option(entry.name, String(index))));
    }

    async function initialize() {
        setBusy(true);
        try {
            selected = await PoloDirectories.get();
            savedDirectory = selected;
            input.value = selected?.name || '';
            const permission = selected ? await selected.queryPermission({mode:'readwrite'}) : 'prompt';
            status.textContent = selected
                ? (permission === 'granted' ? '已保存 · 已授权'
                    : permission === 'denied' ? '目录已保存 · 读写权限被拒绝，可点击保存重新申请'
                    : '目录已记住 · 点击保存确认权限；若出现“每次访问都允许”，请选择该项')
                : '选择文件夹后点击保存';
            await renderHistory();
        } catch (error) { status.textContent = '读取目录失败：' + error.message; }
        finally { setBusy(false); }
    }

    choose.addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        try {
            // 用已保存的真实句柄定位初始目录，不依赖绝对路径或未保存的选择。
            // 仍直接在点击中打开，保留浏览器要求的用户操作资格。
            const options = {id:'ps-edit-images',mode:'readwrite'};
            if (savedDirectory) options.startIn = savedDirectory;
            const handle = await window.showDirectoryPicker(options);
            selected = handle;
            input.value = handle.name;
            status.textContent = '已选择 · 点击保存后生效';
        } catch (error) {
            if (error.name !== 'AbortError') status.textContent = '选择失败：' + error.message;
        } finally { setBusy(false); }
    });

    history.addEventListener('change', () => {
        if (busy || history.value === '') return;
        selected = entries[Number(history.value)]?.handle || null;
        input.value = selected?.name || '';
        status.textContent = '已选择历史目录 · 点击保存后生效';
        setBusy(false);
    });

    save.addEventListener('click', async () => {
        if (busy || !selected) return;
        setBusy(true);
        try {
            // 直接在点击中申请权限；历史句柄存在不代表仍有读写权限。
            // 已确认授权的当前选择不再重复申请；prompt保留用户点击以申请长期权限。
            const existing = await selected.queryPermission({mode:'readwrite'});
            const permission = existing === 'granted' ? existing
                : await selected.requestPermission({mode:'readwrite'});
            if (permission !== 'granted') throw new Error('未取得读写权限，原目录未更改');
            await PoloDirectories.saveSelection(selected);
            savedDirectory = selected;
            window.dispatchEvent?.(new Event('polo-directory-saved'));
            status.textContent = '已保存 · 已授权';
            await renderHistory();
        } catch (error) { status.textContent = '保存失败：' + error.message; }
        finally { setBusy(false); }
    });

    initialize();
})();
