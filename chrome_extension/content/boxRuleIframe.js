// ============================================================
// 箱规填写 iframe 内嵌脚本（注入 scm.alibaba.com 的模板关联弹窗 iframe）
// 职责：在弹窗 iframe 内按固定步骤完成"手动设置 → 一箱多件 →
//       填写 50*40*30 行件数 25 → 关联 → 确认完成"的箱规配置
// 通信：监听 chrome.runtime 消息 fillBoxRuleIframe / pingBoxRuleIframe
//       结果通过 sendResponse 回传给 background
// ============================================================
(function() {
    'use strict';

    if (window.__boxRuleIframeInjected) return;
    window.__boxRuleIframeInjected = true;

    // 延时工具（毫秒）
    function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    // 模拟真实鼠标点击（坐标 + 完整指针事件序列）
    // 阿里这套 next-* 组件大多把逻辑挂在 pointerdown / mousedown 上，
    // 只发 mousedown/mouseup/click 会出现"点了没反应"（箱规步骤1/2 就这样卡住）。
    // 这里按浏览器的真实顺序补齐 pointerdown → mousedown → pointerup → mouseup → click。
    function nativeClick(el) {
        if (!el) return;
        var rect = el.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        var base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0, detail: 1 };
        var pointer = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        try { el.dispatchEvent(new PointerEvent('pointerdown', pointer)); } catch (_) {}
        el.dispatchEvent(new MouseEvent('mousedown', base));
        try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointer, { buttons: 0 }))); } catch (_) {}
        el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
        el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 })));
    }

    // 单选/复选：优先点里面的 input，再补一次原生 click。
    // 只点外层 label/包装元素时，next-radio 有时不切换选中态。
    function clickRadio(el) {
        if (!el) return;
        var input = el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]');
        nativeClick(input || el);
        try { if (input && !input.checked) input.click(); } catch (_) {}
    }

    // 带 [BoxRule] 前缀的日志；同时回传 background → 主页面日志面板。
    // 以前只写 iframe 自己的 console，箱规卡住时主页面完全看不到停在哪一步。
    function log(msg) {
        console.log('[BoxRule]', msg);
        try { chrome.runtime.sendMessage({ action: 'boxRuleLog', msg: String(msg) }); } catch (_) {}
    }

    // 按文本在常见按钮/单选元素中查找可见元素（多选择器兜底）
    function findEl(text) {
        var selectors = ['button', '.next-btn', 'label', '.next-radio-wrapper', '.ant-radio-wrapper', '[class*="radio"]'];
        for (var i = 0; i < selectors.length; i++) {
            var els = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < els.length; j++) {
                var t = (els[j].innerText || els[j].textContent || '').trim();
                var isButton = els[j].matches('button, .next-btn');
                if ((isButton ? t === text : t.indexOf(text) >= 0) && els[j].offsetParent !== null && !els[j].disabled) {
                    return els[j];
                }
            }
        }
        return null;
    }

    function findTargetRow() {
        return Array.from(document.querySelectorAll('tr, .next-table-row')).find(function(row) {
            return /50\s*[*x×]\s*40\s*[*x×]\s*30/i.test(row.innerText || '');
        }) || null;
    }

    async function fillBoxRule() {
        var result = { s1: false, s2: false, s3: false, s4: false, s5: false, s6: false };

        try {
            log('========== 开始 ==========');

            await sleep(800);

            // 已到箱规列表时直接处理该列表，不再重走不存在的向导步骤。
            if (findTargetRow()) { result.s1 = result.s2 = result.s3 = true; }
            // 步骤1: 手动设置
            if (!result.s1) try {
                // 弹窗刚出现时选项可能还没渲染：最多找 4 次（间隔 400ms），别一次没找到就整步失败
                var manual = null;
                for (var t1 = 0; t1 < 4 && !manual; t1++) {
                    manual = findEl('手动设置');
                    if (!manual) await sleep(400);
                }
                if (manual) {
                    log('找到手动设置');
                    clickRadio(manual);
                    await sleep(500);
                    if (!findEl('确认') && !findEl('下一步') && !findTargetRow()) {
                        log('手动设置未生效，补点一次');
                        clickRadio(manual);
                        await sleep(600);
                    }
                }
                if (!manual) throw new Error('未找到手动设置选项');
                var next1 = findEl('确认') || findEl('下一步');
                if (next1) {
                    log('点击' + next1.innerText.trim());
                    nativeClick(next1);
                    await sleep(1500);
                    result.s1 = true;
                }
            } catch(e) { log('步骤1异常: ' + e.message); }
            if (!result.s1) return result;

            await sleep(800);

            if (findTargetRow()) { result.s2 = result.s3 = true; }
            // 步骤2: 一箱多件
            if (!result.s2) try {
                var multi = null;
                for (var t2 = 0; t2 < 4 && !multi; t2++) {
                    multi = findEl('一箱多件');
                    if (!multi) await sleep(400);
                }
                if (multi) {
                    log('找到一箱多件');
                    clickRadio(multi);
                    await sleep(500);
                    if (!findEl('下一步') && !findEl('确认') && !findTargetRow()) {
                        log('一箱多件未生效，补点一次');
                        clickRadio(multi);
                        await sleep(600);
                    }
                }
                if (!multi) throw new Error('未找到一箱多件选项');
                var confirm1 = findEl('下一步') || findEl('确认');
                if (confirm1) {
                    log('点击' + confirm1.innerText.trim());
                    nativeClick(confirm1);
                    await sleep(1500);
                    result.s2 = true;
                }
            } catch(e) { log('步骤2异常: ' + e.message); }
            if (!result.s2) return result;

            await sleep(1000);

            if (findTargetRow()) result.s3 = true;
            // 部分页面直接进入列表，只有尚未进入时才点击下一步。
            if (!result.s3) try {
                var next2 = findEl('下一步');
                if (next2) {
                    log('点击下一步');
                    nativeClick(next2);
                    await sleep(1500);
                    result.s3 = true;
                }
            } catch(e) { log('步骤3异常: ' + e.message); }
            if (!result.s3) return result;

            await sleep(1500);

            // 步骤4: 输入25
            try {
                log('查找50*40*30行');
                var rows = document.querySelectorAll('tr, .next-table-row');
                var targetRow = null;
                for (var i = 0; i < rows.length; i++) {
                    var text = rows[i].innerText || '';
                    if (/50\s*[*x×]\s*40\s*[*x×]\s*30/i.test(text)) {
                        targetRow = rows[i];
                        log('找到目标行');
                        break;
                    }
                }

                if (targetRow) {
                    var inputEl = targetRow.querySelector('input[type="number"], .next-number-picker input, input[aria-valuemax]');
                    // 已关联的箱规把件数显示成文本；先取消本行关联才能修改。
                    if (!inputEl) {
                        var cancelBtn = Array.from(targetRow.querySelectorAll('button, .next-btn')).find(function(btn) {
                            return (btn.innerText || btn.textContent || '').trim() === '取消关联' &&
                                btn.offsetParent !== null && !btn.disabled;
                        });
                        if (cancelBtn) {
                            log('取消目标箱规旧关联，重新填写25件');
                            nativeClick(cancelBtn);
                            for (var waitInput = 0; waitInput < 20 && !inputEl; waitInput++) {
                                await sleep(250);
                                var cancelDialog = Array.from(document.querySelectorAll('.next-dialog')).find(function(dialog) {
                                    return dialog.offsetParent !== null && (dialog.innerText || '').includes('确认取消关联');
                                });
                                if (cancelDialog) {
                                    var confirmCancel = Array.from(cancelDialog.querySelectorAll('button')).find(function(btn) {
                                        return (btn.innerText || '').trim() === '确定' && !btn.disabled;
                                    });
                                    if (confirmCancel) nativeClick(confirmCancel);
                                }
                                targetRow = findTargetRow();
                                inputEl = targetRow && targetRow.querySelector('input[type="number"], .next-number-picker input, input[aria-valuemax]');
                            }
                        }
                    }
                    if (inputEl) {
                        log('找到输入框，开始输入25');

                        inputEl.focus();
                        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                        setter.call(inputEl, '25');
                        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                        await sleep(800);

                        inputEl.blur();
                        await sleep(500);

                        log('输入完成');
                        result.s4 = inputEl.value === '25';
                    }
                }
            } catch(e) { log('步骤4异常: ' + e.message); }
            if (!result.s4) return result;

            await sleep(1000);

            // 步骤5: 关联
            try {
                log('查找关联按钮（50*40*30行）');
                var associateBtn = null;
                var rows = document.querySelectorAll('tr, .next-table-row');
                for (var i = 0; i < rows.length; i++) {
                    var text = rows[i].innerText || '';
                    if (/50\s*[*x×]\s*40\s*[*x×]\s*30/i.test(text)) {
                        var btns = rows[i].querySelectorAll('button, .next-btn');
                        for (var j = 0; j < btns.length; j++) {
                            var t = (btns[j].innerText || '').trim();
                            if (t === '关联' && btns[j].offsetParent !== null) {
                                associateBtn = btns[j];
                                break;
                            }
                        }
                        if (associateBtn) break;
                    }
                }

                if (associateBtn) {
                    if (associateBtn.disabled || associateBtn.classList.contains('disabled') || !result.s4) {
                        throw new Error('箱规件数尚未生效或关联按钮不可用');
                    }
                    log('点击关联');
                    nativeClick(associateBtn);
                    await sleep(1500);
                    result.s5 = true;
                }
            } catch(e) { log('步骤5异常: ' + e.message); }
            if (!result.s5) return result;

            await sleep(1500);

            // 确认运费只进入预估页，只有最终确认完成才结束关联流程。
            try {
                var freightClicked = false;
                var confirmClicked = false;
                for (var attempt = 0; attempt < 40; attempt++) {
                    var finish = findEl('确认完成') || findEl('完成');
                    if (finish) {
                        log('点击' + finish.innerText.trim());
                        nativeClick(finish);
                        await sleep(1000);
                        result.s6 = true;
                        break;
                    }
                    var freight = findEl('确认运费');
                    if (freight && !freightClicked) {
                        log('点击确认运费，等待运费预估页');
                        nativeClick(freight);
                        freightClicked = true;
                    } else if (!freight && !confirmClicked) {
                        var confirm = findEl('确认');
                        if (confirm) {
                            log('点击确认，等待最终确认完成');
                            nativeClick(confirm);
                            confirmClicked = true;
                        }
                    }
                    await sleep(250);
                }
                if (!result.s6) log('未找到最终确认完成按钮，箱规尚未完成');
            } catch(e) { log('步骤6异常: ' + e.message); }

            log('========== 结束 ==========');
            log('结果: ' + JSON.stringify(result));

        } catch(e) {
            log('fillBoxRule异常: ' + e.message);
        }

        return result;
    }

    // 消息入口：fillBoxRuleIframe 执行六步箱规填写，pingBoxRuleIframe 探活
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (request.action === 'fillBoxRuleIframe') {
            fillBoxRule().then(function(result) {
                var ok = result.s1 && result.s2 && result.s3 && result.s4 && result.s5 && result.s6;
                sendResponse({ ok: ok, steps: result });
            }).catch(function(err) {
                sendResponse({ ok: false, error: err.message });
            });
            return true;
        }
        if (request.action === 'pingBoxRuleIframe') {
            sendResponse({ ok: true });
            return true;
        }
        return false;
    });
})();
