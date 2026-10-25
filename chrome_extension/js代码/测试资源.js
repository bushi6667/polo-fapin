/**
 * 测试资源脚本 — SDK v2.2 + @contract
 *
 * @contract
 * @needs canvas:main
 * @needs resources:images
 * @needs resources:infoFile
 * @supports single
 * @fallback alert
 * @timeout 60000
 *
 * @resource images folder "图片文件夹" from:user
 * @resource infoFile file "信息文件" from:user
 *
 * 测试脚本：从文件夹随机取2张图片拼到画布上，并显示txt内容
 * 通过 ctx.data.loadResource 主动获取 images（folder 类型）和 infoFile（file 类型）
 */
CustomJsSDK.run(async ctx => {
  const { canvas, ctx: g } = ctx;

  // images: folder 类型资源（{文件名: dataURL}）
  const imageFiles = (await ctx.data.loadResource('images')) || {};
  // infoFile: file 类型资源（dataURL 字符串）
  const infoFileUrl = await ctx.data.loadResource('infoFile');

  ctx.log('[测试脚本] 资源列表: images=' + Object.keys(imageFiles).length + ' 个, infoFile=' + (infoFileUrl ? '存在' : '不存在'));

  const imageNames = Object.keys(imageFiles).filter(name => /\.(jpg|jpeg|png|webp|gif)$/i.test(name));
  ctx.log('[测试脚本] 图片文件列表: ' + imageNames.join(', '));

  if (imageNames.length < 2) {
    g.fillStyle = 'red';
    g.font = '30px sans-serif';
    g.fillText('图片不足2张，当前: ' + imageNames.length, 50, 100);
    return;
  }

  const shuffled = imageNames.sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, 2);
  ctx.log('[测试脚本] 随机选中: ' + picked.join(', '));

  // 并行加载两张图片（onerror 也 resolve，避免单张失败阻塞整批；未加载的图 width=0，后续 scale=0 自然不显示）
  const imgs = await Promise.all(picked.map(name => {
    return new Promise(resolve => {
      const tmpImg = new Image();
      tmpImg.onload = () => resolve(tmpImg);
      tmpImg.onerror = () => resolve(tmpImg);
      tmpImg.src = imageFiles[name];
    });
  }));

  const w = canvas.width;
  const h = canvas.height;

  g.fillStyle = '#1a1a2e';
  g.fillRect(0, 0, w, h);

  const thumbW = w / 2 - 20;
  const thumbH = h - 120;

  for (let i = 0; i < 2; i++) {
    const x = 10 + i * (thumbW + 20);
    const y = 60;

    const scale = Math.min(thumbW / imgs[i].width, thumbH / imgs[i].height);
    const dw = imgs[i].width * scale;
    const dh = imgs[i].height * scale;
    const dx = x + (thumbW - dw) / 2;
    const dy = y + (thumbH - dh) / 2;

    g.drawImage(imgs[i], dx, dy, dw, dh);

    g.fillStyle = 'white';
    g.font = '14px sans-serif';
    g.fillText(picked[i], dx, dy - 5);
  }

  g.fillStyle = '#00d4ff';
  g.font = 'bold 20px sans-serif';
  g.fillText('随机图片测试 - 共' + imageNames.length + '张', 20, 35);

  if (infoFileUrl) {
    g.fillStyle = '#88ff88';
    g.font = '14px sans-serif';
    g.fillText('信息文件: 已配置', 20, h - 20);
  } else {
    g.fillStyle = '#ff8888';
    g.font = '14px sans-serif';
    g.fillText('信息文件: 未配置', 20, h - 20);
  }
}, {
  timeoutMs: 60000,
  preserveLegacySignals: true,
});
