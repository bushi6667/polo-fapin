# 「指定重生成」按钮 实施计划

## 一、需求

在 `发品助手.html` 增加一个按钮：**手动输入行号 → 只对这些行执行 AI 换色**，
用于重跑此前核查出的 69 套问题颜色图。

## 二、现状（复用基础）

`发品助手.html` 已有完整的「一键换色」批量机制：

| 组件 | 位置 | 作用 |
|---|---|---|
| `startBatchColorChange()` | L3855 | 建队列（当前款 → 最后一款）并启动 |
| `startBatchColorPolling()` | L3906 | 轮询兜底（防 SW 休眠丢完成事件） |
| `processNextBatchColor()` | L3937 | 逐款发 `startColorChange` 给扩展 |
| `setupBatchColorTimeout()` | L3969 | 单款 6 分钟超时跳过 |
| `advanceBatchColorForRow()` | L3353 | 完成推进（消息 + 轮询双入口去重） |
| `finishBatchColor()` | L4009 | 收尾、恢复按钮 |
| `batchColorState` | L3847 | 队列状态机 |

**结论：新功能只需换「队列怎么来」，其余流程全部复用。**

## 三、交互设计

```
点【🔁 指定重生成】
  ↓
输入框（预填上次输入）
  提示：空格 / 逗号 / 换行分隔，支持 315-357 区间
  例：32 42 44 48 49 52
  ↓
解析 → 与 products 按 .row 匹配
  ↓
confirm：「将对指定的 N 款依次执行：<行号列表>」
         「⚠️ 不在当前 Excel 中，将跳过 M 个：...」
  ↓
复用一键换色的进度条 / 停止按钮 / 超时逻辑
```

行为约定：
- 按**用户输入顺序**执行，不重排、不去重后再排序
- 输入里去重（同一行号写两次只跑一次），保留首次出现顺序
- 找不到的行号**列出并跳过**，不静默丢弃
- 输入以 localStorage 记住（key `polo_color_rows_last`），下次点击预填
- 不按 `status` 过滤（用户显式指定，尊重用户意图）

## 四、改动清单（全部手工编辑，禁脚本改写）

### 改动 1 — `发品助手.html` L3046 后：新增按钮

改前：
```html
                            <button class="batch-color-btn" onclick="startBatchColorChange()" id="batchColorBtn" style="justify-content: center;">
                                🚀 一键换色
                            </button>
                            <button class="color-change-btn" onclick="startColorChange(${p.row})" id="colorChangeBtn" style="justify-content: center;">
```

改后：
```html
                            <button class="batch-color-btn" onclick="startBatchColorChange()" id="batchColorBtn" style="justify-content: center;">
                                🚀 一键换色
                            </button>
                            <button class="batch-color-btn" onclick="startColorChangeForRows()" id="colorRowsBtn" style="justify-content: center;">
                                🔁 指定重生成
                            </button>
                            <button class="color-change-btn" onclick="startColorChange(${p.row})" id="colorChangeBtn" style="justify-content: center;">
```

### 改动 2 — L3886–3902：队列初始化抽成 `beginColorBatch()`

改前（`startBatchColorChange()` 尾部）：
```js
    batchColorState = {
        running: true,
        stopRequested: false,
        queue: remainingList.map((p, i) => ({ ...p, _idx: i })),
        currentIndex: 0,
        successCount: 0,
        failCount: 0,
        startTime: Date.now(),
        startRow: remainingList[0].row,
        lastAdvancedRow: null,
        lastProcessedTimestamp: 0,
        pollTimer: null
    };

    showBatchColorProgress();
    startBatchColorPolling();
    processNextBatchColor();
}
```

改后：
```js
    beginColorBatch(remainingList, '一键换色');
}

// 批量换色统一启动入口：一键换色与「指定重生成」共用
function beginColorBatch(queueList, label) {
    batchColorState = {
        running: true,
        stopRequested: false,
        queue: queueList.map((p, i) => ({ ...p, _idx: i })),
        currentIndex: 0,
        successCount: 0,
        failCount: 0,
        startTime: Date.now(),
        startRow: queueList[0].row,
        lastAdvancedRow: null,
        lastProcessedTimestamp: 0,
        pollTimer: null,
        label: label || '批量换色'
    };

    showBatchColorProgress();
    startBatchColorPolling();
    processNextBatchColor();
}
```
> 注意：不触碰 `startBatchColorChange()` 里含中文引号的 confirm 文案行。

### 改动 3 — 新增 `parseRowNumbers()` 与 `startColorChangeForRows()`

插入位置：`// 轮询兜底：SW 休眠导致 port/tabs.sendMessage 失效时，从 storage 读取完成事件推进` 之前。

```js
// 解析行号输入：空格 / 英文逗号 / 中文逗号 / 分号 / 换行分隔，支持 a-b 区间
function parseRowNumbers(text) {
    const seen = new Set();
    const out = [];
    const push = (n) => {
        if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    };
    const norm = String(text || '').replace(/\s*[-~—]\s*/g, '-');
    for (const t of norm.split(/[\s,，;；、]+/).filter(Boolean)) {
        const m = t.match(/^(\d+)-(\d+)$/);
        if (m) {
            let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            if (a > b) { const tmp = a; a = b; b = tmp; }
            if (b - a > 2000) continue; // 防误输入把区间撑爆
            for (let i = a; i <= b; i++) push(i);
        } else if (/^\d+$/.test(t)) {
            push(parseInt(t, 10));
        }
    }
    return out;
}

// 指定重生成：输入行号，只跑这些行（复用一键换色的队列/进度/停止/超时逻辑）
function startColorChangeForRows() {
    if (!products || products.length === 0) {
        showToast('⚠️ 请先上传 Excel');
        return;
    }
    if (batchColorState && batchColorState.running) {
        showToast('⚠️ 换色任务正在进行中');
        return;
    }
    if (!extensionInstalled) {
        showToast('⚠️ 请确认扩展已安装');
        return;
    }

    const lastInput = localStorage.getItem('polo_color_rows_last') || '';
    const input = prompt(
        '输入要重新生成的行号\n（空格 / 逗号 / 换行分隔，支持 315-357 区间）\n\n例：32 42 44 48 49 52',
        lastInput
    );
    if (input === null) return;

    const rows = parseRowNumbers(input);
    if (rows.length === 0) {
        showToast('⚠️ 没解析到有效行号');
        return;
    }

    const byRow = new Map(products.map(p => [p.row, p]));
    const queue = [];
    const missing = [];
    for (const r of rows) {
        const p = byRow.get(r);
        if (p) queue.push(p); else missing.push(r);
    }
    if (queue.length === 0) {
        showToast(`⚠️ 这些行号都不在当前 Excel：${missing.slice(0, 8).join(' ')}${missing.length > 8 ? ' ...' : ''}`);
        return;
    }

    const missMsg = missing.length
        ? `\n\n⚠️ 不在当前 Excel 中，将跳过 ${missing.length} 个：\n${missing.slice(0, 30).join(' ')}${missing.length > 30 ? ' ...' : ''}`
        : '';
    const ok = confirm(
        `将对指定的 ${queue.length} 款产品依次执行 AI 换色：\n\n${queue.map(p => p.row).join(' ')}${missMsg}\n\n确定开始？`
    );
    if (!ok) return;

    localStorage.setItem('polo_color_rows_last', input.trim());
    beginColorBatch(queue, '指定重生成');
}
```

### 改动 4 — L4046 `showBatchColorProgress()`：同时禁用新按钮

改前：
```js
    const btn = document.getElementById('batchColorBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 批量运行中...'; }
}
```
改后：
```js
    const btn = document.getElementById('batchColorBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 批量运行中...'; }
    const rowsBtn = document.getElementById('colorRowsBtn');
    if (rowsBtn) rowsBtn.disabled = true;
}
```

### 改动 5 — L4037 `finishBatchColor()`：恢复新按钮

改前：
```js
        const btn = document.getElementById('batchColorBtn');
        if (btn) { btn.disabled = false; btn.innerHTML = '🚀 一键换色'; }
    }, 5000);
```
改后：
```js
        const btn = document.getElementById('batchColorBtn');
        if (btn) { btn.disabled = false; btn.innerHTML = '🚀 一键换色'; }
        const rowsBtn = document.getElementById('colorRowsBtn');
        if (rowsBtn) rowsBtn.disabled = false;
    }, 5000);
```

### 改动 6 — 状态文案带模式名（3 小处）

- `finishBatchColor()` 开头 `if (!batchColorState) return;` 后加：
  ```js
      const batchLabel = batchColorState.label || '批量换色';
  ```
- `updateBatchColorStatus(\`✅ 已完成 ...\`)` → `✅ ${batchLabel}完成 ...`
- `showToast(\`✅ 批量换色完成！...\`)` → `✅ ${batchLabel}完成！...`
- `updateBatchColorStatus(\`⏸ 已停止。...\`)` → `⏸ ${batchLabel}已停止。...`
- `showToast(\`⏸ 批量换色已停止。...\`)` → `⏸ ${batchLabel}已停止。...`
- `updateBatchColorProgress()`：`🚀 批量换色中 ${current}/${total}` → `🚀 ${batchColorState.label || '批量换色'}中 ${current}/${total}`

### 不改动的部分
- `startColorChange()`（单行换色）、`stopBatchColorChange()`、轮询/超时/去重逻辑
- `getMainImagePath()`、`loadColorImagesFromExtension()`
- 扩展侧（`background.js` / `doubao.js` / 各 content script）**完全不动**

## 五、验证步骤

1. **静态**：`node --check` 不适用（HTML 内联脚本）→ 用浏览器打开，看控制台无语法错误
2. **UI**：按钮出现在「🚀 一键换色」下方，样式一致
3. **解析**：手工验证以下输入
   - `32 42 44` → 3 个
   - `32,42,44` / `32，42，44` → 各 3 个
   - `315-320` → 6 个；`320-315` → 6 个（自动反序）
   - `32 32 42` → 2 个（去重）
   - `abc` / 空 → 提示"没解析到有效行号"
   - `99999` → 提示"都不在当前 Excel"
4. **功能**：输入 1 个真实行号跑通，确认落到 `rowN/rowN_色名.png`
5. **中断**：「停止」按钮可用，收尾文案正确
6. **按钮态**：运行中两个按钮都禁用，结束 5 秒后都恢复

## 六、约束

- **全程手工编辑**，禁止用脚本改写代码（脚本仅限图片提取 / Excel 写入 / 字符统计）
- 每处改动单独一次编辑；改完**重读文件**复核，不凭记忆
- 不动计划外的任何逻辑
- 实施前先 commit 一个备份点

## 七、可选扩展（本次不做）

- 把 69 套问题行号作为输入框默认值预置
- 从外部清单文件（`_color600/需重新生成_逐套核查版.txt`）一键导入
- 支持 `row32` 这种带前缀写法直接粘贴
