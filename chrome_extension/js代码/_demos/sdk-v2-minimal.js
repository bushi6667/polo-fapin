/**
 * @file sdk-v2-minimal.js
 * @description SDK v2.1 最小可运行 demo，展示 query-first + 双层回退的核心用法
 * @usage 把按钮 action 配置为 "custom:_demos/sdk-v2-minimal.js"，点击按钮即可在审查单张链路跑通
 *
 *  这个 demo 演示：
 *   1) ctx.data.text() 读文本资源（底层 query.loadResource，失败回退 args.resources）
 *   2) ctx.data.weightTier() 三档克重转换（与 Python 版 111 对齐）
 *   3) ctx.log/warn 打日志（底层 query.log，失败回退 appendLog + console）
 *   4) ctx.canvas/ctx 直接操作（底层 query.getCanvas，失败回退 L1 字段）
 *   5) ctx.files.writeExtra() 写 debug.json（底层 query.writeFile → A 批白名单 output/pending）
 *   6) 自动 done / 标准错误前缀 / 超时保护（SDK v2.1 自动处理，脚本作者不用管）
 */

CustomJsSDK.run(async (ctx) => {
  // ---- 1. 画布：从 ctx 解构拿（底层 query.getCanvas，query-first）----
  const { canvas, ctx: g } = ctx;

  // ---- 2. 文本资源：读「克重.txt」（底层 query.loadResource，不在 args.resources 里就返回 defaultVal='250'）----
  const weight = await ctx.data.text('克重.txt', '250');
  const tier = ctx.data.weightTier(weight);

  // ---- 3. 日志：query-first 打审查进度区日志（带 taskId 前缀）----
  ctx.log(`[sdk-v2-demo] 套装名 = ${ctx.meta.folderName || '未知'}，imgType = ${ctx.imgType || '?'}`);
  ctx.log(`[sdk-v2-demo] 读取到克重 = ${weight} → 档位 = ${tier || '无法识别'}`);
  if (!tier) ctx.warn('[sdk-v2-demo] 克重无法识别为三档（需 <200/200-350/>350），使用默认中');

  // ---- 4. 画一条对角线 + 文字（SDK v2：脚本作者只写业务代码，done 信号自动处理）----
  if (g && canvas) {
    const W = canvas.width, H = canvas.height;
    // 对角线
    g.strokeStyle = (tier === '薄') ? '#3498db' : (tier === '中' ? '#f39c12' : '#e74c3c');
    g.lineWidth = Math.max(4, Math.round(Math.min(W, H) / 100));
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(W, H);
    g.stroke();
    // 文字胶囊（磨砂玻璃效果，演示 SDK 不强制要求用磨砂库，想调高级库请在 ctx.files 里读）
    const label = `克重:${weight} [${tier || '?'}]`;
    g.font = `${Math.round(H / 22)}px -apple-system, "PingFang SC", sans-serif`;
    const metrics = g.measureText(label);
    const padX = Math.round(W / 40);
    const padY = Math.round(H / 60);
    const boxW = metrics.width + padX * 2;
    const boxH = Math.round(H / 18) + padY * 2;
    const boxX = Math.round(W / 2 - boxW / 2);
    const boxY = Math.round(H / 10);
    g.fillStyle = 'rgba(255,255,255,0.72)'; // 磨砂玻璃白底
    g.filter = 'blur(0.3px)';
    const r = Math.min(boxH / 2, 16);
    // 圆角矩形（原生 API 兼容性：老浏览器用 4 条线模拟）
    g.beginPath();
    g.moveTo(boxX + r, boxY);
    g.lineTo(boxX + boxW - r, boxY);
    g.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
    g.lineTo(boxX + boxW, boxY + boxH - r);
    g.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
    g.lineTo(boxX + r, boxY + boxH);
    g.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
    g.lineTo(boxX, boxY + r);
    g.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
    g.closePath();
    g.fill();
    g.filter = 'none';
    // 文字
    g.fillStyle = '#1a1a1a';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText(label, Math.round(W / 2), boxY + Math.round(boxH / 2));
  }

  // ---- 5. 写 debug.json 到 output（底层 query.writeFile → 白名单校验）----
  await ctx.files.writeExtra('debug_sdk_v2.json', JSON.stringify({
    at: new Date().toISOString(),
    folderName: ctx.meta.folderName,
    imgType: ctx.imgType,
    weight, tier,
    semanticRole: ctx.meta.semanticRole,
    overwriteOriginal: ctx.meta.overwriteOriginal,
    sdkVersion: CustomJsSDK.version,
    queryLayerAvailable: !!(window.__customJsArgs__ && window.__customJsArgs__.query),
  }, null, 2));

  ctx.log(`[sdk-v2-demo] ✅ 完成；已写出 debug_sdk_v2.json`);
  ctx.log(`[sdk-v2-demo] 双层回退验证：__customJsArgs__.query 可用 = ${!!(window.__customJsArgs__ && window.__customJsArgs__.query)}`);

  // 注意：不需要主动调 query.done() / __customJsDone__ = true
  // SDK.run() 会在 asyncFn resolve 后**自动**调 done()，并且如果你 return 一个 canvas 会自动替换主输出。
  // 如果脚本想主动替换主 canvas，在这里 return 一个新的 canvas 即可。

}, {
  timeoutMs: 60_000,          // demo 只给 60s 超时（111/222 真业务脚本默认 120s）
  requireResources: [],       // demo 不 require 任何资源；真脚本写 ['克重.txt', '标题.txt']
  preserveLegacySignals: true, // 默认 true：同时写 __reviewCustomJsDone__/Error__（兼容旧脚本自己的读取逻辑）
});
