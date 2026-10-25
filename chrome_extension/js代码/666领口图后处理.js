/**
 * 666 领口细节图后处理脚本 — SDK v2.2 + @contract
 *
 * @contract
 * @needs canvas:main
 * @needs row:product
 * @supports single
 * @fallback alert
 * @timeout 120000
 *
 * @resource productRow row "当前产品行（Excel）" from:currentSet.row
 *
 * 数据来源：ctx.data.excelRow —— 当前导入 Excel 的当前产品行快照，按真实 Excel 列名取值。
 * 列名随类目变化，统一由 CategoryFieldRules 角色解析：
 *   领 → shirt / 帽衫 / 无帽卫衣 = 领型，t-shirt = 领子，polo 无此列；
 *   编织 → polo / shirt / t-shirt = 编织方法，帽衫 / 无帽卫衣 = 编织方式；
 *   衣服门襟 仅 shirt 有；设计 除 shirt 外都有。
 *
 * 完全对齐 Python image_review_regen_gui.py 的 _draw_detail_text_on_image 实现。
 * 移植自 L143-358（_get_detail_text_content + _draw_detail_text_on_image + _analyze_image_color）。
 */
CustomJsSDK.run(async ctx => {
  const { canvas, ctx: g } = ctx;
  // 当前产品行快照；缺失即报错，不静默回退到空值
  if (!ctx.data.excelRow) throw new Error('缺少当前产品行数据（excelRow）');

  // ============================================================
  // 常量（移植自 L114-123）
  // ============================================================
  // ============================================================
  // 工具函数 —— 共享实现放在 SDK 的 ctx.draw（单一真源），本脚本只做绑定与适配
  //
  // 此前 222/333/666 各自内联同一套 5 个绘制函数 + tagList（共约 300 行重复），
  // 且已出现漂移（标题断行正则只在 333 修过、变量名 t/tt 不一致）。
  // 现统一由 ctx.draw 提供，调用点写法保持不变。
  // ============================================================
  const { rgbToHsv, hsvToRgb, cleanText, sameDisplayText, tagList, splitPctLines } = ctx.draw;

  /** _clean：空值/none/n/a 归一为空字符串 */
  const _clean = (val) => (!val || ['none', 'n/a', 'na'].includes(val.toLowerCase())) ? '' : val;

  /** 绑定本脚本的 2D 上下文 g（调用点不变） */
  function drawTextWithStroke(text, x, y, fillColor, strokeColor, offset) {
    ctx.draw.drawTextWithStroke(g, text, x, y, fillColor, strokeColor, offset);
  }

  function drawRoundedRect(x, y, w, h, r) {
    ctx.draw.drawRoundedRect(g, x, y, w, h, r);
  }

  // ============================================================
  // 读取属性（移植自 L423-436）
  // ============================================================
  // 领列随类目变化（polo 无此列）：shirt / 帽衫 / 无帽卫衣 → 领型；t-shirt → 领子
  const collarVal = _clean(ctx.data.optionalRole('collar').value);
  const collarType = collarVal;
  // 衣服门襟：仅 shirt 有此列
  const placket = _clean(ctx.data.optionalRole('placket').value);
  // 编织列随类目变化：polo / shirt / t-shirt → 编织方法；帽衫 / 无帽卫衣 → 编织方式
  const weave = _clean(ctx.data.role('weave').value);
  const design = _clean(ctx.data.optionalRole('design').value);
  const groupVal = ctx.data.category();

  // ============================================================
  // 颜色分析（移植自 _analyze_image_color L78-110）
  // ============================================================
  const W = canvas.width;
  const H = canvas.height;
  let rs = 0, gs = 0, bs = 0, ct = 0;
  try {
    const imageData = g.getImageData(0, 0, W, H);
    const data = imageData.data;
    for (let y = 0; y < H; y += 10) {
      for (let x = 0; x < W; x += 10) {
        const idx = (y * W + x) * 4;
        const r = data[idx], g2 = data[idx + 1], b = data[idx + 2];
        const lum = r * 299 + g2 * 587 + b * 114;
        if (lum < 600000 && lum > 30000) {
          rs += r; gs += g2; bs += b; ct++;
        }
      }
    }
  } catch (e) { /* 跨域等异常，降级使用默认色 */ }

  let titleColor, titleStrokeRgba, accentColor, accentRgbSum;
  let badgeBgRgba;

  if (ct > 0) {
    const avgR = Math.floor(rs / ct);
    const avgG = Math.floor(gs / ct);
    const avgB = Math.floor(bs / ct);
    const brightness = Math.floor((avgR * 299 + avgG * 587 + avgB * 114) / 1000);
    if (brightness > 150) {
      titleColor = 'rgb(40, 40, 50)';
      titleStrokeRgba = 'rgba(255, 255, 255, 0.39)';
    } else {
      titleColor = 'rgb(255, 255, 255)';
      titleStrokeRgba = 'rgba(0, 0, 0, 0.39)';
    }
    const [h, s, v] = rgbToHsv(avgR, avgG, avgB);
    // accent_color：相邻色（色相+0.1）
    const h2 = (h + 0.1) % 1.0;
    const s2 = Math.min(1.0, s * 1.5);
    const v2 = brightness > 150 ? 0.4 : 0.7;
    const [ar, ag, ab] = hsvToRgb(h2, s2, v2);
    accentColor = `rgb(${ar}, ${ag}, ${ab})`;
    accentRgbSum = ar + ag + ab;
    // badge_bg：互补色（色相+0.5）
    const h3 = (h + 0.5) % 1.0;
    const s3 = Math.max(0.3, Math.min(0.6, s * 1.2));
    const v3 = v < 0.5 ? 0.75 : 0.35;
    const [br, bg, bb] = hsvToRgb(h3, s3, v3);
    badgeBgRgba = `rgba(${br}, ${bg}, ${bb}, 0.9)`;
  } else {
    titleColor = 'rgb(40, 40, 50)';
    titleStrokeRgba = 'rgba(255, 255, 255, 0.39)';
    accentColor = 'rgb(120, 120, 120)';
    accentRgbSum = 360;
    badgeBgRgba = 'rgba(60, 65, 75, 0.9)';
  }

  // ============================================================
  // 文字内容生成（移植自 _get_detail_text_content L168-181）
  // ============================================================
  let title = collarVal || weave || design;
  if (!title) throw new Error('缺少领型、编织方法和设计属性，无法标注领口图');
  const isShirt = groupVal === 'shirt';
  const allTags = isShirt ? tagList(collarType, placket) : tagList(weave, design);
  let tags, subtitle;
  if (allTags.length > 0) {
    // 取最长标签（移植自 max(all_tags, key=len)）
    tags = allTags.reduce((a, b) => a.length > b.length ? a : b);
    subtitle = '';
  } else {
    tags = '';
    subtitle = collarVal ? collarVal.toUpperCase() : '';
  }
  const badge = '';
  const badgePos = 'br';

  // cleanText 清理
  title = cleanText(title);
  subtitle = cleanText(subtitle);
  tags = cleanText(tags);
  if (sameDisplayText(tags, title)) tags = '';

  // ============================================================
  // 绘制（移植自 _draw_detail_text_on_image L248-358）
  // ============================================================
  const SEPARATOR = ' ';
  g.textAlign = 'center';
  g.textBaseline = 'top';

  // --- 大标题 ---
  const fsTitle = Math.floor(H * 0.07);
  let currentFsTitle = fsTitle;
  g.font = `bold ${fsTitle}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const maxW = Math.floor(W * 0.88);

  // 标题换行：\n → 百分比拆分 → 空格二分（移植自 L258-276）
  let titleLines;
  if (title.includes('\n')) {
    titleLines = title.split('\n');
  } else {
    const titleWidth = g.measureText(title).width;
    if (titleWidth > maxW) {
      // 百分比拆分：95%Cotton 5%Elastane
      const pctParts = splitPctLines(title);
      if (pctParts.length > 1) {
        titleLines = pctParts;
        currentFsTitle = Math.floor(H * 0.055);
        g.font = `bold ${currentFsTitle}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
      } else {
        const words = title.split(' ');
        const mid = Math.floor(words.length / 2);
        titleLines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
        currentFsTitle = Math.floor(H * 0.055);
        g.font = `bold ${currentFsTitle}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
      }
    } else {
      titleLines = [title];
    }
  }

  const ty = Math.floor(H * 0.06);
  for (let i = 0; i < titleLines.length; i++) {
    const ly = ty + i * Math.floor(currentFsTitle * 1.3);
    drawTextWithStroke(titleLines[i], W / 2, ly, titleColor, titleStrokeRgba, 5);
  }

  // --- 副标题 ---
  const fsSub = Math.floor(H * 0.05);
  g.font = `bold ${fsSub}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const sy = ty + titleLines.length * Math.floor(currentFsTitle * 1.3) + Math.floor(currentFsTitle * 0.3);

  if (subtitle) {
    const subStroke = accentRgbSum > 382 ? 'rgba(0, 0, 0, 0.39)' : 'rgba(255, 255, 255, 0.47)';
    drawTextWithStroke(subtitle, W / 2, sy, accentColor, subStroke, 3);
  }

  // --- 标签行 ---
  const fsTag = Math.floor(H * 0.03);
  g.font = `bold ${fsTag}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const tagParts = tags ? tags.split(SEPARATOR).filter(p => p) : [];
  const tagMaxW = Math.floor(W * 0.88);
  const partWidths = tagParts.map(p => g.measureText(p).width);
  const sepW = g.measureText(SEPARATOR).width;
  const totalW = tagParts.length > 0
    ? partWidths.reduce((a, b) => a + b, 0) + (tagParts.length - 1) * sepW
    : 0;

  // 标签换行（移植自 L308-317）
  let tagLines;
  if (totalW > tagMaxW && tagParts.length > 1) {
    let bestMid = 1, bestDiff = 999999;
    for (let mid = 1; mid < tagParts.length; mid++) {
      const w1 = partWidths.slice(0, mid).reduce((a, b) => a + b, 0) + Math.max(0, mid - 1) * sepW;
      const w2 = partWidths.slice(mid).reduce((a, b) => a + b, 0) + Math.max(0, tagParts.length - mid - 1) * sepW;
      const diff = Math.abs(w1 - w2);
      if (diff < bestDiff) { bestDiff = diff; bestMid = mid; }
    }
    tagLines = [
      tagParts.slice(0, bestMid).join(SEPARATOR),
      tagParts.slice(bestMid).join(SEPARATOR)
    ];
  } else {
    tagLines = tags ? [tags] : [];
  }

  const tagY = sy + (subtitle ? Math.floor(fsSub * 1.8) : 0);
  const tagStroke = accentRgbSum > 382 ? 'rgba(0, 0, 0, 0.39)' : 'rgba(255, 255, 255, 0.47)';

  for (let li = 0; li < tagLines.length; li++) {
    const line = tagLines[li];
    const ly = tagY + li * Math.floor(fsTag * 1.8);
    drawTextWithStroke(line, W / 2, ly, accentColor, tagStroke, 3);
  }

  // 666 无 badge

  ctx.log('OK 666领口标注完成');
}, {
  timeoutMs: 120000,
  preserveLegacySignals: true,
});
