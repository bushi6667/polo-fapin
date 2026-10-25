// 完整路径用于现有发品/图片逻辑；选择器只返回句柄，不能把name冒充完整路径。
(() => {
    const controllers = {};
    window.PoloPathPickers = controllers;
    for (const kind of ['helper-path', 'color-img-dir']) {
        const button = document.getElementById('choose-' + kind);
        const input = document.getElementById(kind);
        const status = document.getElementById(kind + '-selection');
        let saved = null;
        let pending = null;
        PoloDirectories.pickerRecord(kind).then(async record => {
            saved = record || null;
            if (kind === 'color-img-dir') {
                const config = await chrome.storage.local.get('polo_color_img_dir');
                const value = config.polo_color_img_dir;
                if (typeof value === 'string' && value.startsWith('polo-dir:')) {
                    saved = await PoloDirectories.pickerRecord(value);
                }
            }
        })
            .catch(error => { status.textContent = '读取定位目录失败：' + error.message; });

        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                const options = {id:kind};
                if (saved?.handle) options.startIn = saved.handle;
                if (kind === 'helper-path') {
                    // 文件框必须由本次点击直接打开；不先等待tab查询，避免丢失用户操作资格。
                    options.types = [{description:'发品助手HTML文件',accept:{'text/html':['.html','.htm']}}];
                    const [handle] = await window.showOpenFilePicker(options);
                    const known = saved?.handle && await handle.isSameEntry(saved.handle);
                    pending = {name:handle.name,handle,path:known?saved.path:null};
                    input.value = handle.name;
                    status.textContent = known ? '已选择保存的文件 · 点击保存后生效'
                        : '已选择 · 保存时自动读取当前打开的助手页面地址';
                    return;
                } else {
                    pending = await window.showDirectoryPicker({...options,mode:'read'});
                }
                if (kind === 'color-img-dir') {
                    input.value = pending.name;
                    status.textContent = '已选择 · 点击保存后生效';
                    return;
                }
                // 只有句柄身份一致，才恢复以前绑定的完整地址；同名不代表同一位置。
                if (saved?.handle && await pending.isSameEntry(saved.handle)) {
                    input.value = saved.path;
                    status.textContent = '已选择保存的路径，点击保存后生效';
                } else {
                    input.value = '';
                    input.placeholder = '已选择 ' + pending.name + '，请粘贴完整路径';
                    status.textContent = '已选择：' + pending.name + '。浏览器不提供完整地址，请粘贴路径后保存。';
                }
            } catch (error) {
                if (error.name !== 'AbortError') status.textContent = '选择失败：' + error.message;
            } finally { button.disabled = false; }
        });

        controllers[kind] = {
            async useSaved(value) {
                pending = null;
                if (PoloDirectories.isColorSelection(value)) saved = await PoloDirectories.pickerRecord(value);
                else saved = {path:value,name:value.replace(/[\\/]+$/, '').split(/[\\/]/).pop()};
            },
            validate() {
                if (kind === 'color-img-dir' || pending?.handle || pending?.path || !pending) return true;
                const path = input.value.trim();
                const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
                if (!/^(?:[A-Za-z]:[\\/]|\/|file:\/\/)/.test(path) || name !== pending.name) {
                    status.textContent = '请填写所选项的完整路径后保存';
                    return false;
                }
                return true;
            },
            async configurationValue() {
                if (kind !== 'color-img-dir') {
                    if (pending?.path) return pending.path;
                    if (pending?.handle) {
                        const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
                        if (!tab?.url?.startsWith('file:')) throw new Error('请先在Chrome打开所选助手HTML，再点击保存');
                        const url = new URL(tab.url);
                        const name = decodeURIComponent(url.pathname.split('/').pop());
                        if (name !== pending.name || !/发品助手.*\.html?$/i.test(name)) throw new Error('当前页面与所选助手文件不符，请先打开所选HTML再保存');
                        let path = decodeURIComponent(url.pathname);
                        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, '\\');
                        else if (url.hostname) path = '\\\\' + url.hostname + path.replace(/\//g, '\\');
                        pending.path = path;
                        return path;
                    }
                    if (saved?.name === input.value && saved.path) return saved.path;
                    const previous = window.PoloSavedHelperPath;
                    if (previous && decodeURIComponent(previous.replace(/[\\/]+$/, '').split(/[\\/]/).pop()) === input.value) return previous;
                    return input.value.trim();
                }
                if (pending) {
                    const record = await PoloDirectories.saveColorSelection(pending);
                    return record.path;
                }
                const config = await chrome.storage.local.get('polo_color_img_dir');
                if (saved && input.value === saved.name) return saved.path;
                const previous = config.polo_color_img_dir || window.PoloSavedColorDir;
                if (previous && previous.replace(/[\\/]+$/, '').split(/[\\/]/).pop() === input.value) return previous;
                return input.value.trim();
            },
            async committed() {
                if (!pending) return;
                try {
                    // 由业务保存成功回调调用，不用计时器猜测保存是否结束。
                    const record = kind === 'color-img-dir'
                        ? await PoloDirectories.pickerRecord('color-img-dir')
                        : {name:pending.name,path:pending.path||input.value.trim(),handle:pending.handle||null};
                    await PoloDirectories.pickerRecord(kind,record);
                    saved = record;
                    pending = null;
                    status.textContent = '已保存，下次选择默认定位到此处';
                } catch (error) { status.textContent = '路径已保存，但定位记录保存失败：' + error.message; }
            }
        };
    }
})();
