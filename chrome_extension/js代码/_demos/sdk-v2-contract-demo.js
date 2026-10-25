/**
 * @contract
 * @needs canvas:main
 * @needs resources:cardImage
 * @supports single
 * @fallback alert
 * @timeout 10000
 *
 * @resource cardImage file "演示卡片图" from:user
 *
 * SDK v2.2 契约 demo 脚本 — 演示 @contract 声明 + ctx.contract + ctx.data.hasResource
 * 运行前需在编辑按钮里配置 cardImage 资源，否则契约校验会 alert 提示缺失
 */

CustomJsSDK.run(async ctx => {
  // 1) 读取自己的契约声明（由 Executor 注入 L7 契约层）
  ctx.log(`契约 needs: ${JSON.stringify(ctx.contract ? ctx.contract.needs : null)}`);
  ctx.log(`支持场景: ${ctx.contract ? ctx.contract.supports.join(', ') : '未知'}`);

  // 2) 资源发现：先看环境里实际有什么
  const available = await ctx.data.listAvailable();
  ctx.log(`可用资源: ${available.join(', ') || '无'}`);

  const hasCard = await ctx.data.hasResource('cardImage');
  ctx.log(`cardImage 可用: ${hasCard}`);

  if (!hasCard) {
    ctx.error('缺 cardImage 资源，无法继续');
    return;
  }

  // 3) 试探性加载（不缓存，不影响后续 loadResource）
  const probe = await ctx.data.probeResource('cardImage');
  ctx.log(`probe 结果: ok=${probe.ok}, error=${probe.error || '无'}`);

  // 4) 正常业务逻辑：在画布左上角画个黄方块
  const { canvas, ctx: g } = ctx;
  g.fillStyle = '#ffff00';
  g.fillRect(0, 0, 50, 50);
  ctx.log('demo 完成');
}, { timeoutMs: 10000 });
