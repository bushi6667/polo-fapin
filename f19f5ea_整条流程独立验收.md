# f19f5ea 整条流程独立验收

基线 f19f5ea（HEAD b8d4ccd 仅归档文档）。结论：暂不通过。按统一清单同时检查实际消息传递、页面状态、后台补发、文件键、恢复入口及结果收尾；下列问题需同批修复。不要再以单个函数能被测试调用作为实际流程已接通的依据。

## 1. P1：实际完成通知仍丢弃 results，成功被记为失败

后台收到 colorTaskComplete 时，将 results 写入存储，但调用 notifyColorTaskComplete(rowNum,batchId)。后者所有通知通道只发送 action/rowNum/batchId，没有 results。页面的新判定要求结果必须存在，因而直接通知先到时判“无执行结果”并记失败；inFlightRow 已清空，随后存储轮询即使拿到正确结果也无法补救。

生产后台函数复现：notifyColorTaskComplete(412,'B') 实际发出 {action:'colorTaskComplete',rowNum:412,batchId:'B'}。生产页面 advanceBatchColorForRow 接收该载荷后 success=0、fail=1、currentIndex=1。

修复：后台通知、存储事件必须使用同一份不可变终态载荷，贯穿结果、执行身份、文件身份。补真实后台 -> 页面入口 -> 轮询的联动测试，覆盖消息先到/轮询先到与重复终态。不要在测试中直接向判定函数注入实际链路未传的 results 来替代。

## 2. P1：结果失败后页面仍标运行中，却不再推进或暂停

advanceBatchColorForRow 的失败分支增加 failCount/currentIndex，保留失败行，然后直接 return；没有将 running=false，也没有继续下一款。启动时 running=true，因此失败后 running 仍 true、inFlightRow=null、派发次数=0。普通“继续”以仍在运行拒绝，进度实际上已停止。

独立生产函数复现 running=true、row412 在途，传无结果/失败结果：running=true、fail=1、index=1、dispatch=0。

修复：失败/部分完成应有明确终态转换。建议暂停并报缺失颜色，允许明确重试/跳过；清理当前超时定时器、持久化暂停状态、恢复正确按钮，不把失败当成功。补运行中失败、末款失败、暂停中失败、失败后恢复，不只测 running=false 的失败用例。

## 3. P1：pending/busy 仍无闭合的接收与恢复流程

- busy 分支恢复旧执行身份，但未撤销新请求 pending。生产后台复现 OLD/row411 忙时尝试 NEW/row412：响应 busy=true，active 身份 OLD，但 pending 仍是 NEW/row412。
- onUpdated 只判断有 pending 就在 2 秒后发送，未校验派发许可、是否停止/切文件、目标执行页和当前任务代次。等待后也未重读身份；保留 pending 并不等于禁止暂停后的补发。
- 页面通信失败时设置 pendingAckRow 并清 inFlightRow；没有处理接收确认的页面消息，也没有明确解决 pendingAckRow 的动作。后台随后接收/完成，页面因非在途行拒绝完成；sendNextBatchColor 又始终被 pendingAckRow 阻挡。
- 新页路径仍返回 ok:true,pending:true，页面当作已接收来启动执行超时，而后台尚未确认接收。
- saveColorBatchState 没存 pendingAckRow；restore 后该字段为 undefined，接收未确定的阻挡事实丢失。

修复：后台权威管理待派发/已接收/执行结束和派发许可；页面与后台接收状态同步。busy 必须撤销本次待派发记录；通信未知应保留身份但禁止自动重发，提供有界查询/明确恢复。后台加载补发前及发送前必须核对当前执行、标签、文件和许可。pending 状态要持久化并可恢复。补实际 onUpdated 路径及页面回调，不用测试内复制的 busy 分支。

## 4. P1：文件绑定仍读取当前文件/当前执行，切文件继续串待办和缓存

### 页面

batchColorState 没有绑定 fileKey。saveColorBatchState 使用 currentFileKey()；get/setColorResumeRows 和 get/setColorTimeoutRows 也使用当前文件。handleColorFileSwitched 保存原任务时，loadedFileName 已变为新文件，直接把原任务重新标成新文件。该处理函数也没有被任何消息监听器调用（全 HTML 中只出现一次定义）。

生产函数复现：在 A 保存 row412/415，切 loadedFileName='B'，调用文件切换处理及 row412 正确完成；快照 fileKey='B__'，剩余 row415 写入 polo_color_resume_rows::B__。原文件任务被新文件接管。

### 后台

boundColorFileInfo 读取全局 activeColorExec，没有根据下载请求绑定不可变执行身份；执行身份被另一启动请求替换或冷启动尚未恢复时，会使用另一任务/当前文件。下载完成回调仍用 colorKey(rowNum)（内部读取 CURRENT_FILENAME）；downloadViaFetch 仍用 CURRENT_FILENAME 写 IndexedDB/storage。

主路径还将已带 '__' 的 fileKey 传入 colorImageIDBKey；读取侧传的是原 filename。生产函数生成键对照：写入 A____row412__white，读取 A__row412__white，不能命中。

修复：创建任务时把原文件绑定入页面任务/执行请求；存储、快照、回调全部接收该绑定值。后台下载携带并校验执行标识后取对应文件，不能以当前 active 代替请求身份。主路径与 fetch fallback 使用同一规范键。恢复/继续切回原文件前拒绝处理旧文件待办。补下载进行中切文件、同一行号、fallback、异步回调、缓存写读一致性。

## 5. P1：恢复函数未接入真实页面启动，且恢复后的在途等待无超时

restoreColorBatchState 在 HTML 中只有定义，无任何调用；loadSavedData 恢复产品后没有恢复换色任务。测试手工调用该函数不代表用户刷新会执行恢复。

即使手工调用，restore 设置 inFlightSince=0，没恢复原期限/超时定时器；只启动轮询。若执行已失败或完成通知永久缺失，会再次永久阻挡继续。快照也不存 pending 状态、当前行开始时间/截止时间、暂停原因；单一全局快照不能可靠保留多个文件未完成任务。

修复：在真实初始化/文件加载/重连入口协调后台身份后恢复任务；保持暂停、不自动派发。恢复在途截止时间和有界查询，超时进入明确处理；按文件保存任务快照，不能被另一任务覆盖。队列产品缺失时不能直接 filter 后沿用旧 currentIndex，应停下说明身份缺失。补真实初始化入口、页面刷新、助手关闭后完成、通知缺失、pending 刷新、切回文件恢复等测试。

## 次要项一并修复

- 执行状态查询门槛仍只使用 fresh/known/busy，未校验 lastExecStatus.exec 是否与当前待确认行、文件和执行一致；后台引擎 task 缺标识时部分条件仍会按已知处理。
- colorTaskAccepted 未写入 sender 的实际 tabId；新页执行 identity.tabId 可能持续为空，查询回退任意豆包页。
- judgeColorTaskResult 的 rowNum 参数未用，仅检查颜色后缀，其他行的四色文件也能判当前行成功。统一载荷应核实本行、本次执行的下载记录。
- stop/finish 收尾需同步持久化状态；不能仅依靠完成前保存的 running=true 快照。

## 本轮交付要求

本次独立重跑 14 个测试文件全部通过（换色 92/92、队列 197/197）；扩展/服务/助手脚本 18 个文件或块语法检查通过。上述复现说明这些测试覆盖仍不完整，不能据此整体放行。

以上是同一任务生命周期的五组缺口，不要求分五轮补丁。先统一权威状态和载荷，再接通所有入口/收尾。

新增验收应调用实际生产分发链：页面请求 -> 后台 -> 豆包接收 -> 接收确认/结果 -> 后台所有通知通道 -> 页面处理/持久化 -> 刷新恢复。外部 API 可 mock，业务控制器不得 mock 掉，也不能用字符串命中或直接调用孤立函数声称全链路通过。

同时保留发品原约束：默认批次 50、1–60 可调、全部目标页上限 60、提交额度/物理内存保护、停止与文件隔离、填完不记保存。保存检测、每批三款和真实内存保护仍待浏览器实测；不能拿本报告中的模拟测试替代。

本次只新增验收文档；未改生产代码、Excel、原始图片，未启动真实生成或发布，未关页或降低阈值。
