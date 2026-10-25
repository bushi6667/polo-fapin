/**
 * 333 面料细节图后处理脚本 — SDK v2.2 + @contract
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
 * 读取 材质 / 面料克重 / 产品特性 / 面料类型 / 图案类型 五列。
 * 注意：五个类目的克重列统一为「面料克重」、特性列统一为「产品特性」，
 *       旧脚本的 克重.txt / 特性.txt 别名已不再需要。
 *
 * 完全对齐 Python image_review_regen_gui.py 的 _draw_detail_text_on_image 实现。
 * 移植自 L143-358（_get_detail_text_content + _draw_detail_text_on_image + _analyze_image_color）。
 */
CustomJsSDK.run(async ctx => {
  const { canvas, ctx: g } = ctx;
  // 当前产品行快照；缺失即报错，不静默回退到空值
  if (!ctx.data.excelRow) throw new Error('缺少当前产品行数据（excelRow）');

  // 只在原图上叠加文字，不改动画面：画布创建时已按原图尺寸绘制，这里不再重绘/裁剪/缩放。
  if (!ctx.img) throw new Error('缺少面料图原始位图');

  // ============================================================
  // 工具函数 —— 共享实现放在 SDK 的 ctx.draw（单一真源），本脚本只做绑定与适配
  //
  // 此前 222/333/666 各自内联同一套 5 个绘制函数 + tagList（共约 300 行重复），
  // 且已出现漂移（变量名 t/tt 不一致）。现统一由 ctx.draw 提供，调用点写法保持不变。
  // ============================================================
  const { rgbToHsv, hsvToRgb, cleanText, formatWeight, tagList, splitPctLines } = ctx.draw;

  /** _clean：空值/none/n/a 归一为空字符串 */
  const _clean = (val) => (!val || ['none', 'n/a', 'na'].includes(val.toLowerCase())) ? '' : val;

  /** _v：按真实 Excel 列名取值 */
  const _v = (column) => _clean(ctx.data.cell(column));

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
  // 真实 Excel 列名；五个类目的克重列统一为「面料克重」、特性列统一为「产品特性」
  const mat = _v('材质');
  const weight = _v('面料克重');
  const feat = _v('产品特性');
  const fabricType = _v('面料类型');
  const pattern = _v('图案类型');

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
  // 文字内容生成（移植自 _get_detail_text_content L160-167）
  // ============================================================
  const displayWeight = formatWeight(weight);
  let title = (displayWeight && mat) ? `${displayWeight} ${mat.toUpperCase()}` : (displayWeight || mat);
  if (!title) throw new Error('缺少克重和材质属性，无法标注面料图');
  const subtitle = '';
  // 标签随机打乱取第一个（移植自 random.shuffle + [0]）
  const allTags = tagList(fabricType, pattern, feat);
  const shuffled = allTags.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const tags = shuffled.length > 0 ? shuffled[0] : '';
  const badge = '';
  const badgePos = 'br';

  // cleanText 清理
  title = cleanText(title);
  // subtitle 为空，跳过
  // tags 已是单个字符串，cleanText 处理
  const cleanedTags = cleanText(tags);

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
      // 百分比拆分：95%Cotton 5%Elastane → 只在百分比前有空格或开头时拆分
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

  // --- 副标题（333 无 subtitle） ---
  const fsSub = Math.floor(H * 0.05);
  g.font = `bold ${fsSub}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const sy = ty + titleLines.length * Math.floor(currentFsTitle * 1.3) + Math.floor(currentFsTitle * 0.3);

  // --- 标签行 ---
  const fsTag = Math.floor(H * 0.03);
  g.font = `bold ${fsTag}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const tagParts = cleanedTags ? cleanedTags.split(SEPARATOR).filter(p => p) : [];
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
    tagLines = cleanedTags ? [cleanedTags] : [];
  }

  const tagY = sy; // 333 无 subtitle，tagY = sy
  const tagStroke = accentRgbSum > 382 ? 'rgba(0, 0, 0, 0.39)' : 'rgba(255, 255, 255, 0.47)';

  for (let li = 0; li < tagLines.length; li++) {
    const line = tagLines[li];
    const ly = tagY + li * Math.floor(fsTag * 1.8);
    drawTextWithStroke(line, W / 2, ly, accentColor, tagStroke, 3);
  }

  // --- badge：圆角黑底白字（移植自 L339-356） ---
  if (badge) {
    const fsBadge = Math.floor(H * 0.038);
    g.font = `bold ${fsBadge}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
    // badge 高度：使用实际测量（移植自 tb[3]-tb[1]+20）
    const badgeMetrics = g.measureText(badge);
    const badgeW = g.measureText(badge).width + 40;
    const badgeH = (badgeMetrics.actualBoundingBoxAscent || fsBadge * 0.8) +
                  (badgeMetrics.actualBoundingBoxDescent || fsBadge * 0.2) + 20;

    let bx, by;
    if (badgePos === 'br') {
      bx = W - badgeW - Math.floor(W * 0.05);
      by = H - badgeH - Math.floor(H * 0.05);
    } else {
      bx = (W - badgeW) / 2;
      by = Math.floor(H * 0.45);
    }

    drawRoundedRect(bx, by, badgeW, badgeH, Math.floor(badgeH / 2));
    g.fillStyle = badgeBgRgba;
    g.fill();

    g.fillStyle = 'rgb(255, 255, 255)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(badge, bx + badgeW / 2, by + badgeH / 2);
  }

  ctx.log('OK 333面料标注完成');
}, {
  timeoutMs: 120000,
  preserveLegacySignals: true,
});
