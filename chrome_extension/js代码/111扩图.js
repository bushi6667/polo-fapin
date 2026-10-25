/**
 * 111扩图 — SDK v2.2 + @contract
 *
 * @contract
 * @needs canvas:main
 * @supports single
 * @fallback alert
 * @timeout 120000
 *
 * 自动检测衣服区域，四周留白不足时扩图/缩图
 * 对齐 Python 扩图工具.py 逻辑，使用 ONNX rembg + Canvas API
 * ONNX session 通过 window 全局缓存跨脚本/跨注入复用（对齐 111卖点图后处理.js）
 */
CustomJsSDK.run(async ctx => {
  const { canvas, ctx: g, img } = ctx;

  const TRIGGER_HIGH = 0.26;
  const TARGET = 0.24;
  const w0 = img.width;
  const h0 = img.height;

  ctx.log('[扩缩图] 原图尺寸: ' + w0 + 'x' + h0);

  // ============================================================
  // 抠图 / 网格分析：共享实现，见 SDK 的 ctx.rembg
  //   111卖点图 / 111扩图 / 444扩图 三份实现实测逻辑一致（仅注释与 const/let 风格不同），
  //   集中到 SDK 后 session 缓存键、320×320 归一化、LANCZOS 回缩放等细节只维护一处。
  //   注意：sampleBgColor 与接缝混合**不在共享范围**（三份签名/算法不同，非重复实现）。
  // ============================================================
  const { getOrCreateU2NetSession, rembgRemoveBackground, gridAnalysis } = ctx.rembg;

  // ============================================================
  // 1. rembg 抠图 → alpha mask —— 已移到共享实现（见上方 ctx.rembg 解构）
  // ============================================================

  // ============================================================
  // 2. 网格分析与衣服检测 —— 已移到共享实现（ctx.rembg.gridAnalysis）
  // ============================================================

  // ============================================================
  // 3. 背景色采样
  // ============================================================
  function sampleBgColor(origCanvas, alphaCanvas) {
    const w = origCanvas.width, h = origCanvas.height;
    const oCtx = origCanvas.getContext('2d');
    const oData = oCtx.getImageData(0, 0, w, h).data;
    const aData = alphaCanvas.getContext('2d').getImageData(0, 0, w, h).data;

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < aData.length; i += 4) {
      if (aData[i] < 13) { // alpha < 5% (≈ 13/255)
        rSum += oData[i];
        gSum += oData[i + 1];
        bSum += oData[i + 2];
        count++;
      }
    }
    if (count > 0) return [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)];
    return [240, 240, 240];
  }

  // ============================================================
  // 4. 接缝模糊混合（cosine-weighted band blur）
  //
  // ⚠️ 与 444扩图.js 的 `blendSeams(newCanvas, origImg, x, y)` **不是同一个函数**：
  //    本函数按「轴向 + 缝位置」作用在已有画布上（targetCanvas, origW, origH, offsetX, offsetY），
  //    444 那份是「双向渐变 + 高斯模糊带」且入参是原图 Image。两者算法与签名都不同，
  //    **不属重复实现，禁止合并**（合并会改变出图结果）。命名相似纯属历史巧合。
  // ============================================================
  function blendSeamBands(targetCanvas, origW, origH, offsetX, offsetY) {
    const nc = targetCanvas.getContext('2d');
    const w = targetCanvas.width, h = targetCanvas.height;
    const blurPct = 0.05;

    function blurBand(axis, seam) {
      const bw = Math.max(1, Math.round(Math.max(w, h) * blurPct));
      const maxAxis = axis === 0 ? h : w;
      const b0 = Math.max(0, seam - bw);
      const b1 = Math.min(maxAxis, seam + bw);
      if (b1 <= b0) return;

      const sx = axis === 0 ? 0 : b0;
      const sy = axis === 0 ? b0 : 0;
      const sw = axis === 0 ? w : b1 - b0;
      const sh = axis === 0 ? b1 - b0 : h;

      // 对整张图做模糊，只取接缝带部分
      const temp = document.createElement('canvas');
      temp.width = w;
      temp.height = h;
      const tc = temp.getContext('2d');
      tc.filter = `blur(${Math.max(3, bw)}px)`;
      tc.drawImage(targetCanvas, 0, 0);

      // 提取模糊带和原图带
      const origBand = nc.getImageData(sx, sy, sw, sh);
      const blurBand = tc.getImageData(sx, sy, sw, sh);
      const outData = nc.createImageData(sw, sh);
      const len = sw * sh;

      for (let i = 0; i < len; i++) {
        const coord = axis === 0 ? Math.floor(i / sw) + sy : (i % sw) + sx;
        let dist = Math.abs(coord - seam) / bw;
        if (dist > 1) dist = 1;
        const t = 0.5 + 0.5 * Math.cos(dist * Math.PI); // cosine ease
        const j = i * 4;
        outData.data[j]   = origBand.data[j]   * (1 - t) + blurBand.data[j]   * t;
        outData.data[j+1] = origBand.data[j+1] * (1 - t) + blurBand.data[j+1] * t;
        outData.data[j+2] = origBand.data[j+2] * (1 - t) + blurBand.data[j+2] * t;
        outData.data[j+3] = 255;
      }
      nc.putImageData(outData, sx, sy);
    }

    // 上接缝
    if (offsetY > 0) blurBand(0, offsetY);
    // 下接缝
    if (offsetY + origH < h) blurBand(0, offsetY + origH);
    // 左接缝
    if (offsetX > 0) blurBand(1, offsetX);
    // 右接缝
    if (offsetX + origW < w) blurBand(1, offsetX + origW);
  }

  // ============================================================
  // 5. 主流程
  // ============================================================
  ctx.log('[扩缩图] 开始 rembg 抠图...');
  const alphaCanvas = await rembgRemoveBackground(img);
  ctx.log('[扩缩图] rembg 完成');

  const { clothCells, cellRatio, bbox } = gridAnalysis(alphaCanvas);
  ctx.log('[扩缩图] 格子占比: ' + (cellRatio * 100).toFixed(1) + '% 衣服格子: ' + clothCells + ' bbox: ' + bbox);

  if (bbox === null) {
    ctx.log('[扩缩图] 未检测到衣服，不调整');
    return;
  }

  if (cellRatio <= TRIGGER_HIGH && cellRatio >= TARGET) {
    ctx.log('[扩缩图] 在范围内 (' + (TARGET*100).toFixed(0) + '%~' + (TRIGGER_HIGH*100).toFixed(0) + '%)，不调整');
    return;
  }

  const scale = Math.sqrt(cellRatio / TARGET);
  const newW = Math.round(w0 * scale);
  const newH = Math.round(h0 * scale);
  const offsetX = Math.floor((newW - w0) / 2);
  const offsetY = Math.floor((newH - h0) / 2);

  if (cellRatio < TARGET) {
    // 缩图：裁剪中心区域
    ctx.log('[扩缩图] 缩小画布: ' + w0 + 'x' + h0 + ' → ' + newW + 'x' + newH);
    const cropX = Math.floor((w0 - newW) / 2);
    const cropY = Math.floor((h0 - newH) / 2);

    const newCanvas = document.createElement('canvas');
    newCanvas.width = newW;
    newCanvas.height = newH;
    const nc2 = newCanvas.getContext('2d');
    nc2.drawImage(img, cropX, cropY, newW, newH, 0, 0, newW, newH);

    // 替换原 canvas
    canvas.width = newW;
    canvas.height = newH;
    g.drawImage(newCanvas, 0, 0);
  } else {
    // 扩图：扩大画布，原图居中
    // 注：expandBot = newH - h0 - offsetY（下方扩展量），expandRight = newW - w0 - offsetX（右方扩展量）
    const expandTop = offsetY;
    const expandBot = newH - h0 - offsetY;
    const expandLeft = offsetX;
    const expandRight = newW - w0 - offsetX;
    ctx.log('[扩缩图] 扩大画布: ' + w0 + 'x' + h0 + ' → ' + newW + 'x' + newH +
            ' 各方向: 上' + expandTop + ' 下' + expandBot + ' 左' + expandLeft + ' 右' + expandRight);

    // 采样背景色
    const bgColor = sampleBgColor(canvas, alphaCanvas);
    ctx.log('[扩缩图] 背景色: RGB(' + bgColor.join(',') + ')');

    // 创建新画布
    const newCanvas = document.createElement('canvas');
    newCanvas.width = newW;
    newCanvas.height = newH;
    const nc2 = newCanvas.getContext('2d');

    // 填充背景色
    nc2.fillStyle = 'rgb(' + bgColor.join(',') + ')';
    nc2.fillRect(0, 0, newW, newH);

    // 画原图居中
    nc2.drawImage(img, offsetX, offsetY);

    // 接缝模糊
    blendSeamBands(newCanvas, w0, h0, offsetX, offsetY);

    // 替换原 canvas
    canvas.width = newW;
    canvas.height = newH;
    g.drawImage(newCanvas, 0, 0);
  }

  ctx.log('[扩缩图] 完成');
}, {
  timeoutMs: 120000,
  preserveLegacySignals: true,
});
