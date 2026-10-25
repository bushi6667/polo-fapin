/**
 * 444 叠加后处理脚本（白底模式）— SDK v2.2 + @contract
 *
 * @contract
 * @needs canvas:main
 * @needs resources:cardImage
 * @supports single
 * @fallback alert
 * @timeout 10000
 *
 * @resource cardImage file "白底卡片图" from:user
 *
 * 通过 ctx.data.loadResource('cardImage') 主动获取白底卡片图（dataUrl），叠加到原图上。
 * 缺素材时由契约校验提前 alert 提示，不会执行到一半才崩。
 */
CustomJsSDK.run(async ctx => {
  const { canvas, ctx: g } = ctx;

  // 资源发现：先探测 cardImage 是否可用
  const hasCard = await ctx.data.hasResource('cardImage');
  if (!hasCard) {
    throw new Error('缺少 cardImage 叠加图片，请在后处理资源配置中选择图片');
  }

  // 加载卡片图 dataUrl
  const cardDataUrl = await ctx.data.loadResource('cardImage');
  const cardImg = new Image();
  cardImg.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    cardImg.onload = resolve;
    cardImg.onerror = () => reject(new Error('卡片图加载失败'));
    cardImg.src = cardDataUrl;
  });

  // 叠加到主画布
  ctx.log('[444叠加] 叠加卡片图...');
  // JPG 模板右侧常是整列纯白留空，直接整图覆盖会把衣服盖掉。
  // 只忽略与右边缘连通的白色空白列，保留左侧模板的完整底色与内容；透明 PNG 仍原样叠加。
  let sourceWidth=cardImg.naturalWidth||cardImg.width;
  const sourceHeight=cardImg.naturalHeight||cardImg.height;
  if(sourceWidth&&sourceHeight){
    const probe=document.createElement('canvas');probe.width=sourceWidth;probe.height=sourceHeight;
    const pg=probe.getContext('2d');pg.drawImage(cardImg,0,0);
    const pixels=pg.getImageData(0,0,sourceWidth,sourceHeight).data;
    let right=sourceWidth;
    for(let x=sourceWidth-1;x>=0;x--){
      let blank=true;
      for(let y=0;y<sourceHeight;y++){
        const i=(y*sourceWidth+x)*4;
        if(pixels[i+3]>8&&(pixels[i]<245||pixels[i+1]<245||pixels[i+2]<245)){blank=false;break;}
      }
      if(!blank)break;right=x;
    }
    // 至少留出 10% 的连通空白才视为版式留白，避免误裁边缘抗锯齿。
    if(right>0&&right<sourceWidth*.9){
      g.drawImage(cardImg,0,0,right,sourceHeight,0,0,canvas.width*right/sourceWidth,canvas.height);
    }else g.drawImage(cardImg,0,0,canvas.width,canvas.height);
    probe.width=probe.height=0;
  }else g.drawImage(cardImg,0,0,canvas.width,canvas.height);
  ctx.log('[444叠加] 叠加完成');
}, {
  timeoutMs: 10000,
  preserveLegacySignals: true,
});

