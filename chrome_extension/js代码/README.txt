=== 标注 JS 编写规范（SDK v2.2 · P3 重写）===

本目录下的 JS 文件由 dashboard 主模块经 CustomJsExecutor 注入执行。

⚠️ 重要：旧版本文档教的写法（window.__customJsArgs__ + 手写 __customJsDone__ /
   __customJsError__，以及读取 args.task）**已全部废弃**。照旧文档写会失败：
   · 现在的入口是 CustomJsSDK.run(async ctx => { ... })
   · 运行时不存在 args.task 字段（属性文本通过 ctx.data.* 读取）
   现有 8 个脚本均已使用 SDK v2.2 写法，可直接参考。

============================================================
一、最小可用示例
============================================================

/**
 * @contract
 * @needs canvas:main
 * @needs row:product
 * @supports single
 * @fallback alert
 * @timeout 60000
 * @resource productRow row "当前产品行（Excel）" from:currentSet.row
 */
CustomJsSDK.run(async (ctx) => {
    // 当前导入 Excel 的当前产品行快照（含 文件/工作表/实际行号/表头），任务开始时锁定
    const t = ctx.data.excelRow;
    const title = ctx.data.cell('标题');        // 直接用真实 Excel 列名取值
    const category = ctx.data.category();       // 归一化类目：polo / shirt / t-shirt / …
    ctx.log('标题：' + title + '，类目：' + category);

    // ctx.canvas / ctx.ctx 由中枢创建，原图已绘制完毕，直接在上面画即可
    // 不要自己创建 canvas，也不要自己导出图片（中枢会自动 toDataURL 并保存）
});

============================================================
二、契约声明（写在文件「第一个」JSDoc 块内）
============================================================

| 标签       | 格式                | 说明                                              |
|------------|---------------------|---------------------------------------------------|
| @contract  | 无参数              | 标记契约块开始；没有它则不解析契约                |
| @needs     | type:key            | 依赖：canvas:main / resources:<key> / meta:<key>  |
| @produces  | type:key            | 产出声明（当前仅作声明，不参与校验）              |
| @supports  | single, batch       | 支持的场景，默认全部支持                          |
| @fallback  | alert/skip/throw    | 资源缺失时的策略，默认 alert（提示用户）          |
| @timeout   | 毫秒                | 覆盖默认超时，钳位到 [3000, 600000]               |

注意：只解析文件「第一个」JSDoc 块。若在契约块之前放了别的 JSDoc（如版权说明），
      契约会静默失效 —— 契约块必须放在文件最前面。

============================================================
三、资源声明 @resource
============================================================

格式：@resource <key> file|folder|row "<标签>" [from:<来源>] ["<文件名>"]

来源：

  from:currentSet.row     当前导入 Excel 的当前产品行（全自动，零配置）★当前数据源
  from:currentSet.images  处理完图片目录（全自动，零配置）
  from:user               公用素材（logo / 色卡 / 白底卡片图等）
  from:currentSet.data    【已弃用】待处理套图目录（文本）；脚本不要再读 *.txt 属性

关于 from:user：
  · 需要在界面里选择一次；P1.5 起按素材 key 全局共享，同一素材不必重复配置
  · 不写 from 时默认为 user

关于 row 类型：
  · 不是文件也不是文件夹，代表「当前产品行」；脚本用 ctx.data.excelRow / ctx.data.cell('真实列名') 读取
  · 保留原始中文列名，不传 material_en 等页面转换后的字段；单元格数值 0 会保留

示例：
  @resource productRow row  "当前产品行（Excel）" from:currentSet.row
  @resource cardImage  file "白底卡片图" from:user

============================================================
四、实际可用的 ctx API（以现有脚本真实用法为准）
============================================================

  ctx.data.loadResource(key)     读取资源；file→字符串/dataUrl，folder→{文件名:内容}
  ctx.data.hasResource(key)      资源是否可用
  ctx.log(...) / ctx.warn(...) / ctx.error(...)   写日志（显示在执行日志面板）

  另可直接使用（由中枢注入）：
  ctx.canvas / ctx.ctx / ctx.img      画布、2D 上下文、原图 Image
  ctx.deepseekApiKey                  DeepSeek Key（如需调用 AI 润色文案）
  ctx.meta                            { jsPath, imgType, folderName, ... }

✅ ctx.draw.* 已实现（SDK v2.2，pages/utils/custom-js-sdk-v2.js）：
     ctx.draw.rgbToHsv / hsvToRgb / cleanText / formatDisplayText / formatWeight /
     sameDisplayText / tagList / splitPctLines / readField / readFirstField /
     drawTextWithStroke / drawRoundedRect
   —— 222/333/666 脚本正在使用；新脚本禁止内联这些函数（共享能力单一真源）。
   另有 ctx.rembg.*（U2Net 抠图 + gridAnalysis）与 ctx.files.*（读套装/待处理目录图片与文本）。

⚠️ 以下 API 尚未实现，请勿使用：
     ctx.ai.*           ctx.sleep()（用 query.sleep / utils sleep）
     ctx.getCurrentSet()   ctx.listAllSets()   ctx.getReviewState()
     ctx.files.globalText() / writeGlobal() / writeOutput()
   （设计文档中的相关承诺与实现不符，一律以本文件为准）

============================================================
五、常见错误
============================================================

1. 沿用旧写法 window.__customJsArgs__ → 应使用 CustomJsSDK.run(ctx => ...)
2. 读取 task['标题.txt'] 或 folder['标题.txt'] → 属性不再来自 TXT 文件夹，应用 ctx.data.cell('标题') / ctx.data.role(...)
3. 自己创建 canvas / 自己 toDataURL → 重复且会被覆盖，直接画在 ctx.canvas 上
4. 契约块没放在第一个 JSDoc 位置 → 契约静默失效（不报错，但 @needs 校验不生效）
5. 声明了资源却取不到值 → 检查 @resource 的 from: 是否正确、对应目录是否已授权

============================================================
六、调试
============================================================

· ctx.log 的输出会出现在 dashboard 的执行日志面板
· 脚本抛错会被执行器捕获，显示为执行失败 + 错误信息
· 超时由 @timeout 控制（默认 120 秒）
