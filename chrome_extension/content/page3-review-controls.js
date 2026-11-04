/* 检查与修复独立，单项修复不会运行其他项。 */
(() => {
 function mount(doc,output,items,execute) {
  const area=doc.createElement('div');area.id='polo-review-repairs';
  const select=doc.createElement('select');select.setAttribute('aria-label','选择需要修复的项目');
  select.style.cssText='width:100%;margin-bottom:6px';
  for(const item of items){const option=doc.createElement('option');option.value=item.action;option.textContent=item.label;select.appendChild(option);}
  const single=doc.createElement('button');single.id='polo-review-single';single.textContent='仅修复所选项';
  const all=doc.createElement('button');all.id='polo-review-all';all.textContent='修复整页空缺';
  for(const button of [single,all])button.style.cssText='min-height:36px;margin:0 6px 8px 0';
  const invoke=async mode=>{select.disabled=true;try{await execute(mode);}finally{select.disabled=false;}};
  single.onclick=()=>invoke({readOnly:false,only:select.value});
  all.onclick=()=>invoke({readOnly:false});
  area.append(select,single,all);output.after(area);
 }
 window.PoloReviewControls={mount};
})();
