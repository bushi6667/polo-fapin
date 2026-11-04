/* 检测补缺复用一键填入，不另写模板交互。 */
(() => {
 const numeric = value => /^\d+(?:\.\d+)?$/.test(String(value||'').trim());
 const current = api => { if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换'); };
 async function confirmTemplate(doc,api={}) {
  let clicked=false;
  for(let round=0;round<40;round++){
   current(api);
   const dialogs=[...doc.querySelectorAll('.size-chart-dialog-confirm,.next-dialog-quick,[role="alertdialog"]')]
    .filter(e=>e.getBoundingClientRect().height>0);
   if(!dialogs.length){
    const inputs=[...doc.querySelectorAll('.size-chart-table-main td[required][name] input')];
    if(clicked||inputs.length&&inputs.every(e=>numeric(e.value)))return;
    await api.wait(150);continue;
   }
   const known=dialogs.filter(e=>/清除尺码表数据/.test(e.textContent||'')&&/请确认是否清空尺码表数据/.test(e.textContent||''));
   if(known.length!==1||dialogs.length!==1)throw Error('尺码确认弹窗不唯一或提示未知，停止');
   if(!clicked){
    api.canConfirm?.();
    const buttons=[...known[0].querySelectorAll('button')].filter(e=>/^(确定|确认|Confirm|OK)$/.test(String(e.innerText||e.textContent||'').trim()));
    if(buttons.length!==1)throw Error('未定位唯一尺码确认按钮');
    const button=buttons[0];
    if(!button.disabled){
     const r=button.getBoundingClientRect();
     if(doc.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')!==button){await api.wait(150);continue;}
     // 原生按钮事件调用平台确认回调，避免调试连接改变弹窗坐标；只点一次，不用ESC取消。
     button.click();clicked=true;
    }
   }
   await api.wait(150);
  }
  throw Error('尺码确认未完成，保留现场，不按ESC取消');
 }
 async function waitMeasurements(doc,api={}){
  for(let round=0;round<40;round++){
   current(api);
   const inputs=[...doc.querySelectorAll('.size-chart-table-main td[required][name] input')];
   if(inputs.length&&inputs.every(e=>numeric(e.value)))return;
   await api.wait(150);
  }
  throw Error('尺码模板实际测量值未完整落入');
 }
 async function repair(doc,product,api={}) {
  if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换');
  const inputs=[...doc.querySelectorAll('.size-chart-table-main td[required][name] input')];
  if(!inputs.length)throw Error('测量控件未加载');
  if(inputs.some(i=>String(i.value||'').trim()))throw Error('尺码表已有测量值，不重选模板');
  if(!api.fill)throw Error('原尺码填入函数未加载');
  await api.fill(product,undefined,{missingOnly:true,isCurrent:api.isCurrent});
  if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换');
  const after=[...doc.querySelectorAll('.size-chart-table-main td[required][name] input')];
  if(!after.length||after.some(i=>!/^\d+(?:\.\d+)?$/.test(String(i.value||'').trim())))throw Error('尺码测量值未完整落入');
 }
 window.PoloReviewSize={repair,confirmTemplate,waitMeasurements};
})();
