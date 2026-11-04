/* 仅修复全空颜色/尺码；已有自定义内容不重置。 */
(() => {
 'use strict';
 const colors=['White','Black','Gray','Navy'],sizes=['s','m','l','xl','2xl','3xl'];
 const norm=s=>String(s||'').replace(/\s/g,'').toLowerCase();
 const colorInputs=doc=>[...doc.querySelectorAll('.posting-field-color-select input[role="colorCombobox"]')];
 // 排除表头内的镜像复选框（th 内隐藏的尺码提示），只保留真正的尺码选择区。
 const boxes=doc=>[...doc.querySelectorAll('.next-checkbox-wrapper')].filter(e=>!e.closest('thead,th,.next-table-header,.next-overlay-wrapper,.next-table-fixed,[class*="filter"]'));
 const label=e=>{const v=norm(e.querySelector('.next-checkbox-label')?.textContent);return v==='xxl'?'2xl':v;};
 const checked=e=>!!e.querySelector('input')?.checked;
 // 复用原 fillColorsPage3 的逐字输入+blur 提交方式；已有自定义颜色不覆盖，只填空行。
 async function commitColor(input,labeL,doc,api,wait) {
  input.scrollIntoView?.({block:'center'});await wait(200);
  if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止颜色补填');
  if(api.click)await api.click(input);
  // 点击可能让用户/页面填入内容；出现非目标值就停止，绝不覆盖自定义颜色。
  const manual=String(input.value||'').trim();
  if(manual&&manual!==labeL)throw Error('颜色内容已变化，停止补填');
  input.focus?.();
  if(doc.execCommand) {
   doc.execCommand('selectAll',false,null);
   doc.execCommand('delete',false,null);
   for(const ch of labeL) { if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止颜色补填'); doc.execCommand('insertText',false,ch);await wait(30); }
  } else if(api.set)api.set(input,labeL);
  input.blur?.();await wait(600);
  try {
   input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true}));
   const body=doc.body;
   if(body) {
    body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    body.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    body.dispatchEvent(new MouseEvent('click',{bubbles:true}));
   }
  } catch(_) {}
  if(String(input.value||'').trim()!==labeL&&api.set) { api.set(input,labeL);input.blur?.();await wait(600); }
  if(String(input.value||'').trim()!==labeL)throw Error('颜色未提交：'+labeL+'（实际：'+String(input.value||'空')+'）');
 }
 async function repair(action,doc,api={}) {
  const wait=api.wait||(ms=>new Promise(r=>setTimeout(r,ms)));
  const guard=()=>{if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止颜色尺码补填');};
  guard();
  if(action==='fill_colors') {
   let inputs=colorInputs(doc);
   if(!inputs.length)throw Error('颜色控件未定位');
   if(inputs.length>colors.length)throw Error('颜色行超过默认清单，不删除行');
   // 先补建到默认行数；已有颜色保持不动。
   while(inputs.length<colors.length) {
    guard();
    const add=doc.querySelector('.add-color-btn,[role="btn-add"]');
    if(!add)throw Error('颜色添加按钮未定位');
    const count=inputs.length;add.scrollIntoView?.({block:'center'});await wait(200);guard();await api.click(add);await wait(700);guard();inputs=colorInputs(doc);
    if(inputs.length!==count+1)throw Error('颜色新增数量不符，停止');
   }
   const existing=inputs.map(e=>String(e.value||'').trim());
   const used=new Set(existing.filter(Boolean).map(norm));
   // 空行只分配尚未使用的默认颜色；已有自定义值保留。
   const remaining=colors.filter(c=>!used.has(norm(c)));
   const targets=inputs.map((input,i)=>existing[i]?null:remaining.shift());
   if(targets.some((t,i)=>!existing[i]&&!t))throw Error('空颜色行超过剩余默认颜色，不猜填');
   for(let i=0;i<inputs.length;i++) {
    if(!targets[i])continue;
    guard();inputs=colorInputs(doc);
    // 行增删会让下标错位，数量一变立即停止，避免把默认色写到别的行。
    if(inputs.length!==existing.length)throw Error('颜色行数变化，停止补填');
    const input=inputs[i];if(!input)throw Error('颜色控件消失');
    if(String(input.value||'').trim())continue;
    await commitColor(input,targets[i],doc,api,wait);
    guard();
   }
   await wait(400);
   const after=colorInputs(doc).map(e=>String(e.value||'').trim());
   if(after.length!==colors.length||after.some(v=>!v))throw Error('颜色复核失败：'+after.map(v=>v||'空').join('|'));
   return {written:targets.filter(Boolean).length,preserved:existing.filter(Boolean).length};
  }
  const known=()=>boxes(doc).filter(e=>/^(xxs|xs|xxl|s|m|l|xl|[2-9]xl|onesize)$/.test(label(e)));
  if(!known().length)throw Error('尺码控件未定位');
  if(sizes.some(s=>known().filter(e=>label(e)===s).length!==1))throw Error('默认尺码控件缺失或不唯一');
  // 已有勾选保留，只补未选中的默认尺码；绝不取消用户已选。
  const initial=new Set(known().filter(e=>checked(e)).map(e=>label(e)));
  const done=[];let written=0;
  for(const size of sizes) {
   guard();
   if(known().some(e=>checked(e)&&!done.includes(label(e))&&!initial.has(label(e))))throw Error('尺码已变化，停止补填');
   const target=known().find(e=>label(e)===size);if(!target)throw Error('尺码控件消失');
   if(checked(target))continue;
   target.scrollIntoView?.({block:'center'});await wait(200);guard();await api.click(target);await wait(250);guard();
   if(!known().some(e=>label(e)===size&&checked(e)))throw Error('尺码未选中：'+size);
   done.push(size);written++;
  }
  if(sizes.some(s=>!known().some(e=>label(e)===s&&checked(e))))throw Error('六码复核失败');
  return {written,preserved:initial.size};
 }
 window.PoloReviewPicks={repair};
})();
