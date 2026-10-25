/**
 * 444 模特图扩图工具 — SDK v2.2 + @contract
 *
 * @contract
 * @needs canvas:main
 * @supports single
 * @fallback alert
 * @timeout 120000
 *
 * 对齐 Python 扩图工具 - 副本.py 的 expand_or_shrink_positional 逻辑。
 * 核心特点：
 *   - 衣服靠右，右侧留白 margin_ratio (默认 2%)
 *   - 目标格子占比 target = 0.35
 *   - 接缝处双向渐变混合 + 高斯模糊带
 *
 * ⚠️ 重要约定：扩图是修改原图本身的操作，确认替换后
 *   444.jpg 和 444原图.jpg 都会被替换为扩图后的新图（对齐 Python 版）。
 *   本脚本只负责把结果画到 canvas（即 444.jpg 的内容），
 *   reviewExpand 函数会负责同时写入 444原图.jpg。
 *
 * 依赖：ONNX Runtime Web (u2net.onnx) 从 chrome.runtime 加载
 *      ONNX session 通过 window 全局缓存跨脚本/跨注入复用（对齐 111卖点图后处理.js）
 */
CustomJsSDK.run(async ctx => {
  const { canvas, ctx: g, img } = ctx;
  const TARGET = 0.35;
  const MARGIN_RATIO = 0.02;
  const w0 = img.width;
  const h0 = img.height;

  ctx.log('[444扩图] 原图尺寸: ' + w0 + 'x' + h0);

  // ============================================================
  // 抠图 / 网格分析：共享实现，见 SDK 的 ctx.rembg
  //   111卖点图 / 111扩图 / 444扩图 三份实现实测逻辑一致（仅注释与 const/let 风格不同），
  //   集中到 SDK 后 session 缓存键、320×320 归一化、LANCZOS 回缩放等细节只维护一处。
  //   注意：sampleBgColor 与接缝混合**不在共享范围**（与 111扩图 的签名/算法不同，非重复实现）。
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
  function sampleBgColor(origImg, alphaCanvas) {
    const w = origImg.width, h = origImg.height;
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    const oCtx = tmpCanvas.getContext('2d');
    oCtx.drawImage(origImg, 0, 0);
    const oData = oCtx.getImageData(0, 0, w, h).data;
    const aData = alphaCanvas.getContext('2d').getImageData(0, 0, w, h).data;

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < aData.length; i += 4) {
      if (aData[i] < 13) {
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
  // 4. 接缝双向渐变混合 + 高斯模糊带
  //    对齐 Python 版 _blend_seams + _blend_blur_band
  //
  // ⚠️ 与 111扩图.js 的 `blendSeamBands(targetCanvas, origW, origH, x, y)` **不是同一个函数**：
  //    本函数入参是原图 Image，做双向渐变 + 高斯模糊带；111扩图 那份按「轴向 + 缝位置」
  //    作用在已有画布上。两者算法与签名都不同，**不属重复实现，禁止合并**
  //    （合并会改变出图结果）。命名相似纯属历史巧合。
  // ============================================================
  function blendSeams(newCanvas, origImg, offsetX, offsetY) {
    const nc = newCanvas.getContext('2d');
    const newW = newCanvas.width;
    const newH = newCanvas.height;
    const origW = origImg.width;
    const origH = origImg.height;

    const srcX0 = Math.max(0, -offsetX);
    const srcY0 = Math.max(0, -offsetY);
    const srcX1 = Math.min(origW, newW - offsetX);
    const srcY1 = Math.min(origH, newH - offsetY);
    const dstX0 = Math.max(0, offsetX);
    const dstY0 = Math.max(0, offsetY);
    const dstX1 = Math.min(newW, offsetX + origW);
    const dstY1 = Math.min(newH, offsetY + origH);

    const visibleW = srcX1 - srcX0;
    const visibleH = srcY1 - srcY0;
    const halfBlend = Math.max(20, Math.min(100, Math.floor(Math.min(visibleW, visibleH) * 0.06)));
    const edgeSkip = Math.max(3, Math.floor(halfBlend * 0.2));

    const origCanvas = document.createElement('canvas');
    origCanvas.width = origW;
    origCanvas.height = origH;
    const origCtx = origCanvas.getContext('2d');
    origCtx.drawImage(origImg, 0, 0);
    const origData = origCtx.getImageData(0, 0, origW, origH).data;

    const imgData = nc.getImageData(0, 0, newW, newH);
    const data = imgData.data;

    function getOrigPixel(x, y) {
      x = Math.max(0, Math.min(origW - 1, x));
      y = Math.max(0, Math.min(origH - 1, y));
      const idx = (y * origW + x) * 4;
      return [origData[idx], origData[idx + 1], origData[idx + 2]];
    }

    function getPixel(x, y) {
      const idx = (y * newW + x) * 4;
      return [data[idx], data[idx + 1], data[idx + 2]];
    }

    function setPixel(x, y, r, g, b) {
      const idx = (y * newW + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
    }

    function lerp(c1, c2, t) {
      return [
        Math.round(c1[0] * (1 - t) + c2[0] * t),
        Math.round(c1[1] * (1 - t) + c2[1] * t),
        Math.round(c1[2] * (1 - t) + c2[2] * t)
      ];
    }

    function ease(t) {
      return (1 - Math.cos(t * Math.PI)) / 2;
    }

    if (srcY0 === 0 && offsetY > 0) {
      const seamY = offsetY;
      const origRefY = Math.min(edgeSkip, origH - 1);
      const topStart = Math.max(0, seamY - halfBlend);
      for (let y = topStart; y < seamY; y++) {
        const t = ease((seamY - y) / halfBlend);
        for (let x = dstX0; x < dstX1; x++) {
          const sx = x - offsetX;
          const origColor = getOrigPixel(Math.max(0, Math.min(origW - 1, sx)), origRefY);
          const expandColor = getPixel(x, y);
          const [r, g, b] = lerp(expandColor, origColor, t);
          setPixel(x, y, r, g, b);
        }
      }
      const botEnd = Math.min(dstY1, seamY + halfBlend);
      for (let y = seamY; y < botEnd; y++) {
        const t = ease((y - seamY) / halfBlend);
        for (let x = dstX0; x < dstX1; x++) {
          const sx = x - offsetX;
          const origColor = getOrigPixel(Math.max(0, Math.min(origW - 1, sx)), y - offsetY);
          const refColor = getOrigPixel(Math.max(0, Math.min(origW - 1, sx)), origRefY);
          const [r, g, b] = lerp(origColor, refColor, t);
          setPixel(x, y, r, g, b);
        }
      }
    }

    if (srcY1 === origH && offsetY + origH < newH) {
      const seamY = offsetY + origH;
      const origRefY = Math.max(origH - 1 - edgeSkip, 0);
      const botEnd = Math.min(newH, seamY + halfBlend);
      for (let y = seamY; y < botEnd; y++) {
        const t = ease((y - seamY) / halfBlend);
        for (let x = dstX0; x < dstX1; x++) {
          const sx = x - offsetX;
          const origColor = getOrigPixel(Math.max(0, Math.min(origW - 1, sx)), origRefY);
          const expandColor = getPixel(x, y);
          const [r, g, b] = lerp(origColor, expandColor, t);
          setPixel(x, y, r, g, b);
        }
      }
      const topStart = Math.max(dstY0, seamY - halfBlend);
      for (let y = topStart; y < seamY; y++) {
        const t = ease((seamY - y) / halfBlend);
        for (let x = dstX0; x < dstX1; x++) {
          const sx = x - offsetX;
          const origColor = getOrigPixel(Math.max(0, Math.min(origW - 1, sx)), y - offsetY);
          const refColor = getOrigPixel(Math.max(0, Math.min(origW - 1, sx)), origRefY);
          const [r, g, b] = lerp(refColor, origColor, t);
          setPixel(x, y, r, g, b);
        }
      }
    }

    if (srcX0 === 0 && offsetX > 0) {
      const seamX = offsetX;
      const origRefX = Math.min(edgeSkip, origW - 1);
      const leftStart = Math.max(0, seamX - halfBlend);
      for (let x = leftStart; x < seamX; x++) {
        const t = ease((seamX - x) / halfBlend);
        for (let y = dstY0; y < dstY1; y++) {
          const sy = y - offsetY;
          const origColor = getOrigPixel(origRefX, Math.max(0, Math.min(origH - 1, sy)));
          const expandColor = getPixel(x, y);
          const [r, g, b] = lerp(expandColor, origColor, t);
          setPixel(x, y, r, g, b);
        }
      }
      const rightEnd = Math.min(dstX1, seamX + halfBlend);
      for (let x = seamX; x < rightEnd; x++) {
        const t = ease((x - seamX) / halfBlend);
        for (let y = dstY0; y < dstY1; y++) {
          const sy = y - offsetY;
          const origColor = getOrigPixel(x - offsetX, Math.max(0, Math.min(origH - 1, sy)));
          const refColor = getOrigPixel(origRefX, Math.max(0, Math.min(origH - 1, sy)));
          const [r, g, b] = lerp(origColor, refColor, t);
          setPixel(x, y, r, g, b);
        }
      }
    }

    if (srcX1 === origW && offsetX + origW < newW) {
      const seamX = offsetX + origW;
      const origRefX = Math.max(origW - 1 - edgeSkip, 0);
      const rightEnd = Math.min(newW, seamX + halfBlend);
      for (let x = seamX; x < rightEnd; x++) {
        const t = ease((x - seamX) / halfBlend);
        for (let y = dstY0; y < dstY1; y++) {
          const sy = y - offsetY;
          const origColor = getOrigPixel(origRefX, Math.max(0, Math.min(origH - 1, sy)));
          const expandColor = getPixel(x, y);
          const [r, g, b] = lerp(origColor, expandColor, t);
          setPixel(x, y, r, g, b);
        }
      }
      const leftStart = Math.max(dstX0, seamX - halfBlend);
      for (let x = leftStart; x < seamX; x++) {
        const t = ease((seamX - x) / halfBlend);
        for (let y = dstY0; y < dstY1; y++) {
          const sy = y - offsetY;
          const origColor = getOrigPixel(x - offsetX, Math.max(0, Math.min(origH - 1, sy)));
          const refColor = getOrigPixel(origRefX, Math.max(0, Math.min(origH - 1, sy)));
          const [r, g, b] = lerp(refColor, origColor, t);
          setPixel(x, y, r, g, b);
        }
      }
    }

    nc.putImageData(imgData, 0, 0);

    const blurPct = 0.05;

    function blendBlurBand(axis, seam) {
      const bw = Math.max(1, Math.round(Math.max(newW, newH) * blurPct));
      const maxAxis = axis === 0 ? newH : newW;
      const b0 = Math.max(0, seam - bw);
      const b1 = Math.min(maxAxis, seam + bw);
      if (b1 <= b0) return;

      const sx = axis === 0 ? 0 : b0;
      const sy = axis === 0 ? b0 : 0;
      const sw = axis === 0 ? newW : b1 - b0;
      const sh = axis === 0 ? b1 - b0 : newH;

      const temp = document.createElement('canvas');
      temp.width = newW;
      temp.height = newH;
      const tc = temp.getContext('2d');
      tc.filter = `blur(${Math.max(3, bw)}px)`;
      tc.drawImage(newCanvas, 0, 0);

      const origBand = nc.getImageData(sx, sy, sw, sh);
      const blurBand = tc.getImageData(sx, sy, sw, sh);
      const outData = nc.createImageData(sw, sh);
      const len = sw * sh;

      for (let i = 0; i < len; i++) {
        const coord = axis === 0 ? Math.floor(i / sw) + sy : (i % sw) + sx;
        let dist = Math.abs(coord - seam) / bw;
        if (dist > 1) dist = 1;
        const t = 0.5 + 0.5 * Math.cos(dist * Math.PI);
        const j = i * 4;
        outData.data[j]   = origBand.data[j]   * (1 - t) + blurBand.data[j]   * t;
        outData.data[j+1] = origBand.data[j+1] * (1 - t) + blurBand.data[j+1] * t;
        outData.data[j+2] = origBand.data[j+2] * (1 - t) + blurBand.data[j+2] * t;
        outData.data[j+3] = 255;
      }
      nc.putImageData(outData, sx, sy);
    }

    if (offsetY > 0) blendBlurBand(0, offsetY);
    if (offsetY + origH < newH) blendBlurBand(0, offsetY + origH);
    if (offsetX > 0) blendBlurBand(1, offsetX);
    if (offsetX + origW < newW) blendBlurBand(1, offsetX + origW);
  }

  // ============================================================
  // 5. 主流程
  // ============================================================
  ctx.log('[444扩图] 开始 rembg 抠图...');
  const alphaCanvas = await rembgRemoveBackground(img);
  ctx.log('[444扩图] rembg 完成');

  const { clothCells, cellRatio, bbox } = gridAnalysis(alphaCanvas);
  ctx.log('[444扩图] 格子占比: ' + (cellRatio * 100).toFixed(1) + '% 衣服格子: ' + clothCells + ' bbox: ' + bbox);

  if (bbox === null) {
    ctx.log('[444扩图] 未检测到衣服，不调整');
    return;
  }

  const [top, bot, left, right] = bbox;
  const scale = Math.sqrt(cellRatio / TARGET);
  const newW = Math.round(w0 * scale);
  const newH = Math.round(h0 * scale);

  ctx.log('[444扩图] 目标占比: ' + TARGET.toFixed(2) + ' 缩放: ' + scale.toFixed(2) + '倍');
  ctx.log('[444扩图] 新画布: ' + newW + 'x' + newH);

  const offsetX = Math.round(newW * (1 - MARGIN_RATIO)) - right;
  const offsetY = Math.floor((newH - h0) / 2);

  const expandLeft = Math.max(0, offsetX);
  const expandRight = Math.max(0, newW - (offsetX + w0));
  const expandTop = Math.max(0, offsetY);
  const expandBot = Math.max(0, newH - (offsetY + h0));

  ctx.log('[444扩图] 各方向扩展: 上' + expandTop + ' 下' + expandBot + ' 左' + expandLeft + ' 右' + expandRight);

  const bgColor = sampleBgColor(img, alphaCanvas);
  ctx.log('[444扩图] 背景色: RGB(' + bgColor.join(',') + ')');

  const newCanvas = document.createElement('canvas');
  newCanvas.width = newW;
  newCanvas.height = newH;
  const nc2 = newCanvas.getContext('2d');

  nc2.fillStyle = 'rgb(' + bgColor.join(',') + ')';
  nc2.fillRect(0, 0, newW, newH);
  nc2.drawImage(img, offsetX, offsetY);

  blendSeams(newCanvas, img, offsetX, offsetY);

  canvas.width = newW;
  canvas.height = newH;
  g.drawImage(newCanvas, 0, 0);

  ctx.log('[444扩图] 完成');
}, {
  timeoutMs: 120000,
  preserveLegacySignals: true,
});
