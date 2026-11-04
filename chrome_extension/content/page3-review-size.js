/* 检测补缺复用一键填入，不另写模板交互。 */
(() => {
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
 window.PoloReviewSize={repair};
})();
