# 发品队列可控化 实施计划（待批准）

作者：助手 ｜ 日期：2026-10-10 ｜ 状态：**待用户批准，尚未动任何代码**

---

## 〇、一句话结论

发品现在的问题是**「自动填完就立刻开下一个标签」**——
它不开手动停止按钮、不检测你保存、标签只增不减，所以堆到 102 个把 Chrome 压死。

要治，必须在**扩展侧的 `processPublishQueue()`**（唯一刹车点）动手，并先定一个核心策略：
**队列什么时候开下一个标签。**

---

## 一、现状（全部来自代码事实，带行号）

### 链路
```
页面 batchPublish()
  → getSelectedProducts()            只按 selectedRows，提交时不再过滤已上传
  → saveBatchProducts + openBatchPublish
        ↓
扩展 openBatchPublish (background.js:632)
  → publishQueue=[...rows]; publishTotal=rows.length
  → processPublishQueue()
        ↓
processPublishQueue() (background.js:240)
  → 内存闸门（system.memory < 1500MB 暂停）
  → openPublishTab(publishQueue[0])  = chrome.tabs.create('easyListing?row=N')
  → 广播 publishProgress
        ↓
【页2】page2.js  (匹配 post.alibaba.com/product/easyListing*)
  getRowFromUrl() → loadBatchProduct → 心跳 → 等3s → autoFillPage2()
  → 劫持 location.href/assign/replace + history.pushState 追加 row=N
  → 自动点「发布产品」→ 跳页3
        ↓
【页3】page3.js  (匹配 post.alibaba.com/product/publish*)
  initPage3() → loadBatchProduct() (page3.js:4402)
    ① getUploadedRows() → 该行已标记 → 日志跳过 + return false   ← 不发 publishCompleted
    ② 心跳 → 等3s → ensureTabActive() → fillAllPage3()
    ③ 「💡 请检查填写内容后，手动点击页面底部的保存按钮」
    ④ 【立刻】markUploaded(row)              ← L4443，你还没保存
    ⑤ 1秒后 publishCompleted(row)            ← L4448，推进队列
        ↓
扩展 publishCompleted (background.js:650) → advancePublishQueue() → shift → 开下一个新标签
        ↓
【人工】你在每个页3标签里核对 → 点平台「保存」    ← 队列不等这一步
```

### 关键事实
| # | 事实 | 依据 |
|---|---|---|
| F1 | `publishCompleted` 在**自动填完 1 秒后**发出，与你是否保存无关 | page3.js:4446-4454 |
| F2 | 因此 N 款 = N 个页3标签**常开**，等你逐个保存 | 设计使然 |
| F3 | 扩展内 `tabs.remove` 命中数 **0**；且页3要求人工保存 → **不能关标签** | 全目录 grep |
| F4 | `markUploaded` 在**你保存之前**就执行 | page3.js:4443 |
| F5 | 全扩展 `markUploaded` 只有 3 个调用点：面板💾保存(L3686)、面板自动填(L4228)、批量(L4443) | grep |
| F6 | **没有任何代码监听平台「保存」按钮的点击**，批量模式不知道你何时保存 | 全目录 grep |
| F7 | 页3 `loadBatchProduct` 遇到"已标记已上传"的行会 `return false`，**不发 publishCompleted** | page3.js:4413-4419 |
| F8 | 队列**只靠 `publishCompleted` 推进**，无超时兜底 | background.js:280-290 |
| F9 | `ensureTabActive()` 每行把前台焦点抢走 | page3.js:913-925 |
| F10 | `isProcessingQueue` 只在 openPublishTab 期间为 true，**不是"流程在跑"的标志** | background.js:263-277 |

---

## 二、问题清单（按严重度）

| # | 问题 | 后果 | 严重度 |
|---|---|---|---|
| **P1** | 队列推进太快，标签只增不减 | 102 个标签 ≈ 23GB → 越过 16GB 物理内存 → 换页卡死 / 崩溃 | 🔴 致命 |
| **P2** | `markUploaded` 早于用户保存（F4/F6） | ①「跳过已上传」会**误跳实际未发布的行** ②重发同一行时队列**永久卡死**（F7+F8） | 🔴 严重 |
| **P3** | 没有手动「停止」 | 想出问题也停不下来 | 🟠 高（用户明确要） |
| **P4** | 进度面板两处（换色在详情面板、发品在产品列表） | 用户只要一处 | 🟠 中（用户明确要） |
| **P5** | `ensureTabActive` 抢焦点 | 队列跑的时候你没法干别的 | 🟡 中 |
| **P6** | 内存闸门测的是**整机**可用内存 | Chrome 自身膨胀时整机常有余量 → 拦不住（本次崩溃就没拦住） | 🟡 中 |

---

## 三、⚠️ 核心抉择：队列什么时候开下一个标签？

**这个决定后面所有改动。请先选。**

### 方案 A —— 维持现状（填完就开）
- 优点：填表不等你，N 个页3一次性摆好
- 缺点：**内存爆，就是现在的崩溃**
- ❌ 不可行

### 方案 B —— 保存后才开下一个（串行）
- 改动：`publishCompleted` 从"填完就发"改为"**检测到你点保存并成功后**才发"
- 结果：**同时在飞的标签恒为 1 个**，内存恒定，永不崩
- 优点：内存最省；「已上传」标记天然正确
- 缺点：你保存完要**等下一款填表**（页2+页3 各等 3 秒 + 填表，约 15–30 秒）

### 方案 C —— 在飞上限 K（推荐）
- 改动：以**「已打开、尚未保存」的发布标签数**为闸门，达到 K（如 3）就不再开新的；你保存完一款 → 减 1 → 自动补开 1 个
- 结果：**同时在飞最多 K 个**，内存可控（K=3 时 ≈ 750MB），你总有几页可以连续处理，不用干等
- 关键：需要一个"这一款已保存"的判定（见下方 P2 修法）
- 优点：内存可控 + 流程度最好
- 缺点：实现最复杂

### 方案 D —— 用「打开的发布标签数」当闸门（不用检测保存）
- 改动：`chrome.tabs.onRemoved` 监听 —— 你**保存完关掉标签**，计数减 1，队列补开下一个；上限 K
- 优点：**不需要检测保存**，最稳；你关掉即代表这页处理完了
- 缺点：要求你养成"保存完就关标签"的习惯

---

## 四、P2 的修法（依赖你在第三节的选择）

### 需要新增：保存检测
批量模式下必须能知道"你点保存了"。三种可选信号，**优先级从高到低**：

| 信号 | 做法 | 可靠性 |
|---|---|---|
| S1 按钮点击 | 监听平台「保存」按钮的 `click`（捕获阶段），点击后延迟 2–3 秒校验 | 高，实现简单 |
| S2 保存成功提示 | MutationObserver 观察成功 toast / 页面状态变化 | 中，需先确认平台的具体提示 |
| S3 URL / 列表变化 | 保存成功后平台可能跳转或改变列表 | 中，需先确认平台行为 |

> **需要你确认**：平台点「保存」之后，页面会出现什么？跳转？弹提示？还是留在原页？—— 这决定 S1 之后能不能校验成功。**这条我无法从代码得知，必须你告诉我或我去看一眼。**

### 配套改动
1. **删掉 page3.js:4443 的提前标记**（批量模式）
2. `publishCompleted` 的发送时机按第三节选定方案调整
3. 给 `loadBatchProduct` 的"跳过已上传"补一条**兜底**：跳过时也要发 `publishCompleted`（否则队列卡死，F7+F8）

---

## 五、逐项改动清单（草案，待批准后才动）

### 扩展侧 `chrome_extension/background.js`
| # | 位置 | 改动 | 对应问题 |
|---|---|---|---|
| E1 | 全局状态 | 新增 `publishRunning` / `publishStopped` 状态（区别于 F10 的 `isProcessingQueue`） | P3 |
| E2 | `processPublishQueue()`:240 | 入口加**停止闸门**：已停止 → 不开新标签，保留队列 | P3 |
| E3 | `processPublishQueue()`:240 | 入口加**在飞上限闸门**（方案 C/D） | P1 |
| E4 | 新增消息 | `pausePublishQueue` / `resumePublishQueue` / `getPublishState` | P3 |
| E5 | 新增监听 | `chrome.tabs.onRemoved` → 在飞计数减 1 → 补开（方案 D） | P1 |
| E6 | `openBatchPublish`:632 | 传回 `paused/running` 状态，供页面按钮初始化 | P3 |
| E7 | `advancePublishQueue`:280 | 队列空时清理在飞计数、广播 done | P1 |

### 页3 `chrome_extension/content/page3.js`
| # | 位置 | 改动 | 对应问题 |
|---|---|---|---|
| E8 | 新增 | **保存检测**（S1/S2/S3 按第四节确定） | P2 |
| E9 | `loadBatchProduct`:4443 | **删除批量模式的提前 `markUploaded`** | P2 |
| E10 | `loadBatchProduct`:4413 | "跳过已上传"分支补发 `publishCompleted` | P2 |
| E11 | `loadBatchProduct`:4446 | `publishCompleted` 时机按第三节调整 | P1 |
| E12 | `ensureTabActive`:913 | 改为**可选**（默认不抢焦点） | P5 |

### 页面 `发品助手.html`
| # | 位置 | 改动 | 对应问题 |
|---|---|---|---|
| E13 | 进度面板 | **合并为一处**：发品进度复用换色进度那个面板（删掉我上轮新加的 `#batchPublishProgress`） | P4 |
| E14 | 面板按钮 | 一套 `⏹ 停止 / ▶ 继续` 一体按钮，按当前跑的是换色还是发品分发 | P3 |
| E15 | `handlePublishProgress` | 改成写共享面板 | P4 |
| E16 | 新增 | 发品停止/继续的消息发送与状态同步 | P3 |

### 可选
| # | 改动 | 对应问题 |
|---|---|---|
| E17 | 内存闸门增加"Chrome 自身提交量"判断（需新权限，不一定拿得到） | P6 |

---

## 六、你需要在开工前回答的 3 个问题

1. **第三节选哪个方案？**（B 串行 / C 在飞上限 K=3 / D 关标签驱动）—— 我推荐 **C**，K 值你定
2. **平台点「保存」后会发生什么？**（跳转 / 弹提示 / 留在原页）—— 决定保存检测怎么写
3. **进度面板放哪？** 你说"用老的颜色进度位置"，但那个面板在**详情面板**里（不选产品时不渲染）。
   - 3a：就放详情面板原位置（可能不选产品时看不到）
   - 3b：把共享面板提为**页面级常驻**（位置和现在视觉一致，但始终可见）—— 我推荐

---

## 七、风险与回滚

| 风险 | 应对 |
|---|---|
| 改 `publishCompleted` 时机打断你现有习惯 | 先 commit 备份点，随时 `git reset --hard` 回滚 |
| 保存检测误判（点了但保存失败） | 延迟 2–3 秒 + 校验信号，双重确认 |
| 在飞上限设太小导致效率下降 | K 做成可配置 |
| 面板合并影响换色流程 | 换色逻辑不动，只改面板 DOM 归属 |

**备份点策略**：动手前 `git tag backup-2026-10-10-pre-publish-control`，每完成一项单独 commit。

---

## 八、不做的事（明确划界）
- ❌ 不关你的发布标签（你要人工保存）
- ❌ 不动换色的生成逻辑
- ❌ 不动 `step_09` 提示词（那是另一条线）
- ❌ 不改你已确认过的重填版 Excel
