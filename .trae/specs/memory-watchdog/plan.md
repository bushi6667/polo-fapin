# 内存水位保护（自动暂停 + 继续）实施计划

## 一、需求
批量换色跑久了 Chrome 内存上涨。要求：**可用内存低于阈值时自动暂停**，用户清理后点【▶ 继续】接着跑。

阈值：**整机可用内存 < 1500 MB 就暂停**（可改）。

## 二、方案
复用已实现的「继续」待办机制（`polo_color_resume_rows` + `▶ 继续` 按钮）。
在 `processNextBatchColor()` 发下一款**之前**插入内存闸门：

```
每款开始前 → 查整机可用内存 → < 1500MB?
   是 → 自动暂停：剩余行写入「继续」待办，状态栏说明原因
   否 → 正常发这款
```

## 三、改动清单（手工编辑，禁脚本）

### E1 — `chrome_extension/manifest.json`
权限数组加 `"system.memory"`（读取整机内存，`chrome.system.memory.getInfo()`）。
> 改权限后**必须在 chrome://extensions 手动重载扩展**。

改前：
```json
  "permissions": ["activeTab", "scripting", "storage", "debugger", "downloads", "webNavigation"],
```
改后：
```json
  "permissions": ["activeTab", "scripting", "storage", "debugger", "downloads", "webNavigation", "system.memory"],
```

### E2 — `chrome_extension/background.js`
在 `onMessageExternal` 的 `handleSharedAction(request, sendResponse);` **之前**插入新动作：

```js
        // 内存水位查询：供「发品助手」批量换色时做暂停保护
        if (request.action === 'getSystemMemory') {
            if (!chrome.system || !chrome.system.memory) {
                sendResponse({ ok: false, error: 'system.memory 权限未生效（需在 chrome://extensions 重新加载扩展）' });
                return true;
            }
            chrome.system.memory.getInfo((info) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                sendResponse({
                    ok: true,
                    capacity: info.capacity,
                    availableCapacity: info.availableCapacity,
                    availableMB: Math.round(info.availableCapacity / 1048576)
                });
            });
            return true;
        }
        handleSharedAction(request, sendResponse);
```

### E3 — `发品助手.html` 按钮列加阈值输入框（L3063 `</button>` 之后、L3064 `</div>` 之前）

```html
                            <div style="display:flex; align-items:center; gap:5px; font-size:11px; color:rgba(255,255,255,0.6); padding-top:2px;">
                                <span>可用内存低于</span>
                                <input id="memPauseInput" type="number" min="200" step="100" value="1500" style="width:56px; padding:2px 4px; border-radius:6px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.9); font-size:11px; text-align:center;">
                                <span>MB 暂停</span>
                            </div>
```

### E4 — `发品助手.html` 新增内存工具函数（放在 `buildRowPreviewLines` 之前）

```js
// ===== 内存水位保护：可用内存低于阈值自动暂停 =====
const MEM_PAUSE_KEY = 'polo_mem_pause_mb';
const MEM_PAUSE_DEFAULT = 1500;

function getMemPauseMB() {
    const v = parseInt(localStorage.getItem(MEM_PAUSE_KEY), 10);
    return Number.isInteger(v) && v >= 200 ? v : MEM_PAUSE_DEFAULT;
}

function setMemPauseMB(v) {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n >= 200) localStorage.setItem(MEM_PAUSE_KEY, String(n));
}

// 查询整机可用内存（走扩展 system.memory；失败返回 null，不阻塞任务）
function querySystemMemoryMB() {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 3000);
        try {
            chrome.runtime.sendMessage(EXTENSION_ID, { action: 'getSystemMemory' }, (resp) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    console.warn('[mem] 查询失败:', chrome.runtime.lastError?.message || resp?.error);
                    resolve(null);
                    return;
                }
                resolve(resp.availableMB);
            });
        } catch (e) {
            if (!done) { done = true; clearTimeout(timer); resolve(null); }
        }
    });
}
```

### E5 — `beginColorBatch` 状态加两个字段
```js
        label: label || '批量换色',
        failedRows: [],
        lastMemMB: 0
```

### E6 — `processNextBatchColor()` 插入内存闸门
把 `const product = ...` 之后到发消息之前，包一层 `querySystemMemoryMB().then()`：

```js
function processNextBatchColor() {
    if (!batchColorState || !batchColorState.running) return;
    if (batchColorState.stopRequested) { finishBatchColor(false); return; }
    if (batchColorState.currentIndex >= batchColorState.queue.length) { finishBatchColor(true); return; }

    // 内存水位闸门：不足则自动暂停，剩余行进「继续」待办
    querySystemMemoryMB().then((availMB) => {
        if (!batchColorState || !batchColorState.running) return;
        const threshold = getMemPauseMB();
        if (availMB !== null) batchColorState.lastMemMB = availMB;
        if (availMB !== null && availMB < threshold) {
            console.warn(`⚠️ 可用内存 ${availMB}MB < 阈值 ${threshold}MB，自动暂停`);
            finishBatchColor(false, `内存不足：可用 ${availMB}MB < ${threshold}MB`);
            return;
        }
        sendNextBatchColor();
    });
}

function sendNextBatchColor() {   // 原 processNextBatchColor 的后半段
    if (!batchColorState || !batchColorState.running) return;
    const product = batchColorState.queue[batchColorState.currentIndex];
    batchColorState.lastAdvancedRow = null;
    updateBatchColorProgress();
    const imagePath = getMainImagePath(product.row);
    chrome.runtime.sendMessage(EXTENSION_ID, {
        action: 'startColorChange', task: { imagePath, prompt: COLOR_PROMPT, rowNum: product.row }
    }, (response) => { ...原逻辑不变... });
}
```

### E7 — `finishBatchColor(completed, reason)` 加可选原因
```js
function finishBatchColor(completed, reason) {
    ...
    } else {
        const why = reason ? `（${reason}）` : '';
        updateBatchColorStatus(`⏸ ${batchLabel}已停止${why}。完成 ${success} 款，失败 ${fail} 款（用时 ${timeStr}）`);
        showToast(`⏸ ${batchLabel}已暂停${why}。完成 ${success} 款${leftOver.length > 0 ? `，还剩 ${leftOver.length} 款可点「继续」` : ''}`);
    }
```

### E8 — `updateBatchColorProgress()` 显示实时可用内存
```js
    if (product && batchColorCurrentEl) {
        const mem = batchColorState.lastMemMB ? ` · 可用 ${(batchColorState.lastMemMB / 1024).toFixed(1)}GB` : '';
        batchColorCurrentEl.textContent = `正在处理 row${product.row} (${product.title_en || '未命名'})${mem}`;
    }
```

### E9 — 3 秒轮询里顺带刷新内存读数（`startBatchColorPolling` 内，完成后）
```js
            // 顺带刷新内存读数（不影响推进逻辑）
            querySystemMemoryMB().then((mb) => {
                if (mb === null || !batchColorState || !batchColorState.running) return;
                batchColorState.lastMemMB = mb;
                updateBatchColorProgress();
            });
```

### E10 — `renderDetail()` 末尾绑定阈值输入框
```js
    syncColorResumeButton();
    const memInput = document.getElementById('memPauseInput');
    if (memInput) {
        memInput.value = String(getMemPauseMB());
        memInput.addEventListener('change', () => {
            setMemPauseMB(memInput.value);
            memInput.value = String(getMemPauseMB());
            showToast(`✅ 内存暂停阈值已设为 ${getMemPauseMB()} MB`);
        });
    }
```

### 不改动
- `finishBatchColor` 的按钮恢复、5 秒重置守卫
- 停止 / 继续 / 指定重生成 / 一键换色的既有行为
- 扩展侧除 E1/E2 外的任何逻辑

## 四、限制（已知）
1. `chrome.system.memory` 给的是**整机可用内存**，不是 Chrome 单独占用（对"防卡死"是对的信号）
2. 闸门**按行生效**：一行约 48 秒，最坏多跑 1 行才停
3. 查询失败（无权限/超时 3 秒）时**放行**，不阻塞任务
4. 改权限后必须手动重载扩展，否则 `getSystemMemory` 返回错误（表现为永不触发暂停）

## 五、验证
1. `node --check chrome_extension/background.js`；`manifest.json` JSON 合法性
2. 跑 `tests/` 全部（12 个文件）
3. 浏览器加载 `发品助手.html`，控制台无报错
4. 阈值输入框显示 1500，改成 3000 后应触发暂停（人为把阈值调到高于当前可用内存即可验证）
5. 触发后：状态栏显示 `⏸ …已停止（内存不足：可用 X MB < Y MB）`，`▶ 继续（剩 N）` 可点
6. 把阈值调回正常 → 点继续 → 正常续跑

## 六、约束
- 全程**手工编辑**，禁脚本改写代码
- 每处单独编辑，改完**重读复核**
- 先 commit 备份点再动手
