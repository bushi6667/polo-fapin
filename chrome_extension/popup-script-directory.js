// 仅配置JS目录及读取授权，不在选择或保存时执行目录中的脚本。
(() => {
    const key = 'js-directory';
    const input = document.getElementById('script-directory');
    const choose = document.getElementById('choose-script-directory');
    const save = document.getElementById('save-script-directory');
    const history = document.getElementById('script-directory-history');
    const status = document.getElementById('script-directory-status');
    let selected = null, saved = null, entries = [], busy = false;
    function setBusy(value) {
        busy = value;
        choose.disabled = history.disabled = value;
        save.disabled = value || !selected;
    }
    async function refresh() {
        saved = await PoloDirectories.pickerRecord(key);
        selected = saved?.handle || null;
        input.value = selected?.name || '';
        entries = await PoloDirectories.pickerRecord(key + '-history') || [];
        history.replaceChildren(new Option('曾经用过...', ''));
        entries.forEach((entry,i)=>history.add(new Option(entry.name,String(i))));
        const permission = selected ? await selected.queryPermission({mode:'read'}) : 'prompt';
        status.textContent = !selected ? '选择文件夹后点击保存'
            : permission === 'granted' ? '已保存 · 已授权' : '目录已记住，使用前可点击保存确认读取权限';
    }
    choose.addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        try {
            const options = {id:'polo-js-scripts',mode:'read'};
            if (saved?.handle) options.startIn = saved.handle;
            selected = await window.showDirectoryPicker(options);
            input.value = selected.name;
            status.textContent = '已选择 · 点击保存后生效';
        } catch(error) {if(error.name!=='AbortError')status.textContent='选择失败：'+error.message;}
        finally {setBusy(false);}
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
            let permission = await selected.queryPermission({mode:'read'});
            if (permission !== 'granted') permission = await selected.requestPermission({mode:'read'});
            if (permission !== 'granted') throw new Error('未取得读取权限，原配置未更改');
            await PoloDirectories.saveNamedSelection(key,selected);
            await refresh();
            window.dispatchEvent(new Event('polo-directory-saved'));
        } catch(error) {status.textContent='保存失败：'+error.message;}
        finally {setBusy(false);}
    });
    setBusy(true);
    refresh().catch(error=>{status.textContent='读取目录失败：'+error.message;}).finally(()=>setBusy(false));
})();
