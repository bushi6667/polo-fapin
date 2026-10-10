# f19f5ea 整条流程验收 —— 实现位置对照

提交：`ad9a31a`（基线 `f19f5ea` / HEAD `b8d4ccd`）
测试：`test-color-batch-pause.js` **92/92**｜`test-publish-queue.js` **204/204**｜`tests/` 14 文件全 PASS｜18 个脚本/块语法通过

---

## 组 1：完成通知丢弃 results → 成功被判失败【已修】

| 反馈点 | 实现位置 |
|---|---|
| 通知通道不带 results | `background.js` `notifyColorTaskComplete(rowNum, batchId, payload)` —— 长连接 / `tabs.sendMessage` / `runtime.sendMessage` **三个通道全部携带** `results` + `fileKey`/`fileFolder`/`execStartedAt` |
| 存储与通知不同源 | `background.js` `colorTaskComplete` 分支 —— 构造**同一份不可变** `payload`（`Object.freeze`），存储事件与通知共用 |
| 页面判定拿不到结果 | `发品助手.html` `handleColorTaskComplete` 与 `startBatchColorPolling` 均把 `results` 传入 `advanceBatchColorForRow` |

**测试**：【39】经真实后台分发链断言存储事件与通知通道都带 `results`（失败结果 + 四色成功明细各一例）。

## 组 2：失败后仍标运行中【已修】

| 反馈点 | 实现位置 |
|---|---|
| 失败分支直接 return，running 仍为 true | `发品助手.html` `advanceBatchColorForRow` 失败/部分分支：清超时定时器 → `failCount++` → 保留失败行 → `currentIndex++` → **`running=false` + `pausedReason`** → `saveColorBatchState()` → 刷新继续列表与状态栏 |

**测试**：【19】上传失败 / 部分完成 / 无结果 → 均不记成功、`running=false`、保留可处理行、报缺失颜色。

## 组 3：pending/busy 接收流程【部分修】

| 反馈点 | 实现位置 | 状态 |
|---|---|---|
| busy 未撤销新 pending | `background.js` `openDoubaoAndStartTask` busy 分支：先 `savePendingColorTask(null)` 再恢复原执行身份 | ✅ |
| 新页路径被当已接收 | 页面 `sendNextBatchColor` 按 `pending/unconfirmed` 处理：不启动执行超时 | ✅ |
| pendingAckRow 未持久化 | `发品助手.html` `save/restoreColorBatchState` 读写 `pendingAckRow` | ✅ |
| onUpdated 补发未校验许可 | 已核对接收结果再清 pending；**停止/切文件/代次/目标执行页的完整许可校验未做** | ⚠️ 未完成 |
| 后台权威派发许可 | **未实现** | ⚠️ 未完成 |

## 组 4：文件绑定【关键项已修】

| 反馈点 | 实现位置 | 状态 |
|---|---|---|
| 待办按当前文件而非任务文件 | `发品助手.html` 新增 `colorBatchFileKey()`；继续/超时集合键改用它 | ✅ |
| 切文件把原任务标成新文件 | 任务创建时绑定 `fileKey`；`handleColorFileSwitched` 用绑定值保存 | ✅ |
| 切换处理未被监听 | 长连接 + `runtime.onMessage` **两处**已接入 `handleColorFileSwitched` | ✅ |
| IDB 键双重后缀（写 A____row412__white / 读 A__row412__white） | `background.js` `downloadDoubaoImage` 写入改用与读取同规范的原始文件名 | ✅ |
| 快照单槽互相覆盖 | 快照按文件分槽 `polo_color_batch_state::<fileKey>` | ✅ |
| `boundColorFileInfo` 读全局 active | **下载请求级不可变执行身份透传未做** | ⚠️ 未完成 |
| `downloadViaFetch` / `colorKey` 仍读 CURRENT_FILENAME | **未改** | ⚠️ 未完成 |

## 组 5：恢复入口与超时兜底【已修】

| 反馈点 | 实现位置 |
|---|---|
| `restoreColorBatchState` 无调用 | `发品助手.html` `handleFile`（文件名就绪后）与启动恢复 `savedFn` 两处调用 |
| 恢复后无超时兜底 | 恢复时按**原期限剩余时间**重新武装（`setupBatchColorTimeoutReentry`） |
| 手工调用才算恢复 | 已接入真实初始化入口 |
| 产品缺失仍沿用旧 currentIndex | 恢复时若行缺失 → **停下并说明身份缺失**，不自动恢复 |

## 次要项

| 项 | 状态 |
|---|---|
| 超时行转「已生成」时 `failCount` 减回（不双计） | ✅ |
| 状态查询绑定执行 `tabId` + 与引擎 `task` 行号/标识核对 | ✅ |
| `lastExecStatus` 与待确认行/文件/执行的完整绑定 | ⚠️ 未完成 |
| `colorTaskAccepted` 写入 `sender.tab.id` | ⚠️ 未完成 |
| `judgeColorTaskResult` 校验本行文件归属 | ⚠️ 未完成 |
| stop/finish 收尾同步持久化 | ⚠️ 未完成 |

---

## 明确未完成（不宣称整体通过）

1. **真实浏览器验证**：发品内存保护、Stage 2 保存检测、每批 3 款预填+人工保存 —— 仍待实测，函数测试不能替代
2. 组 3 的**后台权威派发许可**与 `onUpdated` 完整许可校验
3. 组 4 的**下载请求级执行身份透传**、`downloadViaFetch`/`colorKey` 的文件键统一
4. 次要项剩余 4 条
5. 平台袖型真实枚举、两张 `_2` 旧图 —— 仍待核 / 未删除

**保留**：发品默认批次 50、1–60 可调、目标页上限 60、提交额度/物理内存保护、停止与文件隔离、填完不记保存。
**未做**：未自动保存、未关页、未取消生成、未下调阈值、未改 Excel 或原图片。
