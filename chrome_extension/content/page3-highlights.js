/* TextAreaList只从ul li读正文；保持平台聚焦时建立的列表，不以普通DOM文字判成功。 */
(() => {
    'use strict';
    const selector = '#struct-textDesc .text-area-list-editor';
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    function inspect(doc = document) {
        const editor = doc.querySelector(selector);
        if (!editor || editor.isConnected === false || (editor.getBoundingClientRect && !editor.getBoundingClientRect().height)) {
            return {state:'unknown', detail:'卖点编辑器未加载或不可见'};
        }
        const rawItems = [...editor.querySelectorAll('ul li')].map(li => String(li.textContent || '').trim()).filter(Boolean);
        const items = rawItems.map(clean);
        const domText = clean(editor.innerText || editor.textContent);
        // .next-input-len属于其他输入控件，不能用作卖点提交证据。
        const counter = doc.querySelector('#textDesc .length');
        const match = String(counter?.textContent || '').trim().match(/^(\d+)\s*\/\s*(\d+)$/);
        const count = match ? Number(match[1]) : null;
        const maximum = match ? Number(match[2]) : null;
        const expectedCount = rawItems.join('\n').replace(/\n/g, '**').length;
        const data = {editor, items, rawItems, domText, count, maximum, expectedCount};
        if (!match) return {...data,state:'unknown',detail:'未定位卖点自身计数器，无法确认提交'};
        if (domText && !items.length) return {...data,state:'unknown',detail:'文字仅在DOM中，缺少平台ul/li正文，不能判通过或覆盖'};
        if (domText !== clean(rawItems.join(' '))) return {...data,state:'unknown',detail:'列表外存在未确认的卖点正文，保持原样，不判通过'};
        if (count !== expectedCount) return {...data,state:'unknown',detail:'卖点计数与列表正文不一致，尚未确认平台接收'};
        if (!items.length) return {...data,state:'fail',detail:'卖点为空'};
        if (count > maximum) return {...data,state:'fail',detail:'卖点超过平台字数上限'};
        return {...data,state:'pass',detail:`平台列表及卖点计数一致（${items.length}条），保留已有内容`};
    }
    function same(items, expected) {
        return items.length === expected.length && items.every((value, i) => value === expected[i]);
    }
    async function write(doc, values, options = {}) {
        const wait = options.wait || delay;
        const mode = options.mode || 'overwrite';
        const lines = values.map(value => String(value || '').replace(/\r?\n/g, ' ').trim()).filter(Boolean);
        if (!lines.length) throw Error('无可写入卖点');
        const current = () => {
            if (options.isCurrent && !options.isCurrent()) throw Error('商品已切换，停止卖点写入');
            const value = inspect(doc);
            if (!value.editor) throw Error(value.detail);
            return value;
        };
        // 给上一轮输入的500ms节流一次完成机会；不把未提交文字当作空白重填。
        let before = current();
        if (before.state === 'unknown') { await wait(650); before = current(); }
        if (before.state === 'unknown') throw Error(before.detail);
        if (options.missingOnly && before.domText) {
            if (before.state !== 'pass') throw Error(before.detail);
            return {skipped:true,count:before.items.length};
        }
        const expected = (mode === 'append' ? before.items : []).concat(lines.map(clean));
        if ((mode === 'append' ? before.rawItems : []).concat(lines).join('\n').replace(/\n/g, '**').length > before.maximum) throw Error('卖点超过平台字数上限，未修改');
        let editor = before.editor;
        editor.scrollIntoView({block:'center'});
        if (options.click) await options.click(editor);
        current();
        editor.focus();
        const focused = () => doc.activeElement === editor || editor.contains(doc.activeElement);
        if (!focused()) throw Error('卖点编辑器未获得焦点，未修改');
        await wait(100);
        let now = current();
        if (now.editor !== editor) throw Error('卖点编辑器已重新渲染，未使用旧节点');
        if (options.missingOnly && now.domText) {
            if (now.state !== 'pass') throw Error('已有内容尚未通过复核，保持原样：'+now.detail);
            return {skipped:true,count:now.items.length};
        }
        if (!same(now.items,before.items)) throw Error('激活期间卖点已变化，未覆盖');
        // 空框已聚焦但未触发初始化时，重新触发一次focus；不手工改innerHTML。
        if (!editor.querySelector('ul li') && !now.domText) {
            editor.blur(); editor.focus(); await wait(100);
        }
        if (!editor.querySelector('ul li')) throw Error('平台未初始化卖点列表，未写入普通div');
        const selection = () => doc.defaultView.getSelection();
        const place = (node, end = false) => {
            const range = doc.createRange(); range.selectNodeContents(node); range.collapse(!end);
            const sel = selection(); sel.removeAllRanges(); sel.addRange(range);
        };
        if (mode !== 'append' && before.domText) {
            // 覆盖仅选择当前列表项内部，保留ul/首个li；禁止全局selectAll。
            const lis = [...editor.querySelectorAll('ul li')];
            const range = doc.createRange(); range.setStart(lis[0],0); range.setEnd(lis.at(-1),lis.at(-1).childNodes.length);
            const sel = selection(); sel.removeAllRanges(); sel.addRange(range);
            if (!doc.execCommand('delete',false,null)) throw Error('未能删除选定卖点文本，停止写入');
        }
        place([...editor.querySelectorAll('ul li')].at(-1),true);
        const enter = () => {
            const count = editor.querySelectorAll('ul li').length;
            editor.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
            if (editor.querySelectorAll('ul li').length !== count + 1) throw Error('平台未创建下一条卖点，停止写入');
        };
        if (mode === 'append' && before.items.length) enter();
        for (let i=0;i<lines.length;i++) {
            current();
            if (!focused()) throw Error('填写期间焦点离开卖点框，停止写入');
            if (i) enter();
            if (!doc.execCommand('insertText',false,lines[i])) throw Error('编辑命令未生效，停止写入');
        }
        editor.dispatchEvent(new doc.defaultView.InputEvent('input',{bubbles:true,inputType:'insertText',data:lines.at(-1)}));
        const verify = async () => {
            await wait(650);
            for (let i=0;i<6;i++) {
                const state = current();
                if (state.state==='pass' && same(state.items,expected)) return state;
                await wait(150);
            }
            throw Error('卖点正文、条数或平台计数未通过完整复核，不能报告成功');
        };
        await verify();
        editor.blur();
        const after = await verify();
        return {count:after.items.length,characters:after.count,skipped:false};
    }
    window.PoloHighlights = {inspect,write,revision:'2026-11-03-list-model-2'};
})();
