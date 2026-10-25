/* Native input is available only to the currently bound suite execution tab. */
'use strict';
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'doubao-native-input') return;
    (async () => {
        const lock = globalThis.__suiteExecLock;
        const tabId = sender.tab && sender.tab.id;
        if (!lock || !tabId || tabId !== lock.tabId || (sender.frameId && sender.frameId !== 0)) throw new Error('原生输入执行身份不匹配');
        const task = await SuiteTaskStore.get(lock.taskId);
        if (!task || task.cancelled || SuiteTaskStore.isTerminal(task.stage)) throw new Error('原生输入任务已结束');
        const target = { tabId };
        const key = async (type, name, code, modifiers = 0) => chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type, key: name, code, modifiers, windowsVirtualKeyCode: name === 'Enter' ? 13 : name === 'Backspace' ? 8 : 65 });
        if (request.command === 'begin') {
            await chrome.debugger.attach(target, '1.3');
            lock.nativeAttached = true;
        } else if (request.command === 'end') {
            await chrome.debugger.detach(target);
            lock.nativeAttached = false;
        } else if (request.command === 'clear') {
            await key('keyDown', 'a', 'KeyA', 2); await key('keyUp', 'a', 'KeyA', 2);
            await key('keyDown', 'Backspace', 'Backspace'); await key('keyUp', 'Backspace', 'Backspace');
        } else if (request.command === 'character') {
            if (request.character === '\n') {
                await key('keyDown', 'Enter', 'Enter', 8); await key('keyUp', 'Enter', 'Enter', 8);
            } else if (request.character === '\r') {
                throw new Error('禁止把普通回车混入输入，必须点击发送按钮');
            } else {
                await chrome.debugger.sendCommand(target, 'Input.insertText', { text: String(request.character || '') });
            }
        } else throw new Error('未知原生输入指令');
        sendResponse({ success: true });
    })().catch(e => sendResponse({ success: false, error: e.message }));
    return true;
});
