/* 定制模板只在全空且唯一精确匹配时应用，不以第一项代替目标。 */
(() => {
 const visible=e=>!!e&&e.isConnected!==false&&(!e.getBoundingClientRect||e.getBoundingClientRect().height>0);
 function unique(options,name){const matches=options.filter(e=>String(e.querySelector?.('.component-template-select-custom-options')?.getAttribute('title')||e.textContent||'').trim()===name);if(matches.length!==1)throw Error('模板目标缺失或不唯一：'+name);return matches[0];}
 async function repairCustom(doc,api={}) {
  const wait=api.wait||(ms=>new Promise(r=>setTimeout(r,ms)));
  const guard=()=>{if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止模板补缺');};
  const area=()=>doc.querySelector('#custom-card');
  const filled=()=>[...area().querySelectorAll('input[type="checkbox"]')].some(e=>e.checked);
  guard();if(!visible(area()))throw Error('定制服务区域未加载');if(filled())return {skipped:true};
  const trigger=area().querySelector('.next-select-trigger');if(!visible(trigger))throw Error('定制模板选择器未定位');
  trigger.scrollIntoView?.({block:'center'});await wait(200);guard();if(filled())return {skipped:true};
  await api.click(trigger);await wait(500);guard();
  try {
   if(filled())return {skipped:true};
   const option=unique([...doc.querySelectorAll('.next-overlay-wrapper [role="option"]')].filter(visible),'通用');
   option.scrollIntoView?.({block:'center'});guard();if(filled())return {skipped:true};await api.click(option);await wait(800);guard();
   const dialogs=[...doc.querySelectorAll('[role="alertdialog"]')].filter(visible);
   if(dialogs.length) {
    const dialog=dialogs[0];
    const fields=[...area().querySelectorAll('input,textarea')].filter(e=>!e.closest?.('.component-select-template,.select-template'));
    const hasData=fields.some(e=>e.type==='checkbox'||e.type==='radio'?e.checked:e.type!=='hidden'&&String(e.value||'').trim());
    const exact=dialogs.length===1&&/数据清空提示/.test(dialog.textContent||'')&&/数据被清空，确认？/.test(dialog.textContent||'');
    if(hasData||!exact){dialog.querySelector('.next-btn-normal')?.click();throw Error('模板确认涉及已有或未知数据，已取消');}
    guard();const confirm=dialog.querySelector('.next-btn-primary');if(!confirm)throw Error('模板确认按钮未定位');
    await api.click(confirm);await wait(800);guard();
   }
   if(!filled())throw Error('定制模板未产生实际勾选内容，不能判通过');
   return {applied:true};
  } finally {doc.body?.click();}
 }
 window.PoloReviewTemplates={unique,repairCustom};
})();
