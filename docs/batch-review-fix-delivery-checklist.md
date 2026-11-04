# 保存与尺码修复交付核对清单

状态：本次按用户要求整理交付1.1.3；实际提交和远端核验结果见最新发布时间记忆。本清单保留已验证行为和提交范围，不替代发布结果。

## 已验证的行为
- 保存按钮连接后重新定位，并确认实际收到点击；明确未触发时仅补救一次，已触发或状态不明不重复保存。
- 页面重载导致探针异常、空结果或首次读取证据暂时失败时，保留本次成功信号并等待新文档，不拿旧轮次或其他商品证据放行。
- 尺码确认不再用ESC取消后报成功；实际测量数字和原尺码选择核验通过后才报成功。
- 第13行已真实补齐36值、保存、重载及自动复查通过；第14行正式原自动入口全程通过，无人工处理或临时注入。
- 第2至14行共13条后台记录均verified=true、reviewPassed=true、reviewPending=false。
- 受控单件只新开第14行；结束后自动暂停并恢复原每批40，剩87件未启动。

## 最终检查
114测试文件101通过、12既有失败、1既有超时，无旧文件新增失败。不能称全量全绿。关键扩展资源page3.js/page3-review-size.js/save-click.js/save-evidence.js的实际加载SHA256与磁盘逐一一致。所有测试scope/数据baseline已清理，没有待恢复或待保存的测试改动。

## 未来提交范围
修改：chrome_extension/background.js、content/page3.js、content/page3-review-size.js。
新增：chrome_extension/upload/save-click.js、upload/save-evidence.js。
测试：test-publish-queue.js、test-save-selfclick.js、test-save-verify.js，以及新增test-save-click.js、test-save-evidence.js、test-size-template-confirm.js。
文档：save-click-confirmation-design.md、size-template-confirmation-design.md和本批docs/memory历史记录。
不纳入源Excel、图片、忽略目录诊断、密钥、runtime或根目录两份历史交接草稿。若正式发布，版本及构建元数据应一并更新，并核对既有pre-commit钩子会自动更新HTML时间戳。

## 边界
检查以是否填写及保存真实性为主，不证明非空文案/数字语义适合商品；非空测量区不自动换模板。未知/未确认项目保持暂停。剩余87件及其他类目不因这次受控通过而视为已经验证。后续是否恢复队列、提交推送由用户决定，不超出“只测试下一件后停住”的授权。
