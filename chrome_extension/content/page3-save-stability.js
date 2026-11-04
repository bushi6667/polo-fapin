/* 保存前等待当前已呈现控件稳定；不替代保存后的持久性核验。 */
(() => {
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 function snapshot(doc){return JSON.stringify([...doc.querySelectorAll('input,textarea,select,[contenteditable="true"]')].filter(e=>!e.closest?.('#polo-helper-panel')&&e.type!=='file').map(e=>[e.id,e.name,e.type,e.value??e.innerText,e.checked]));}
 async function wait(doc,options={}) {
  const pause=options.wait||delay,read=options.read||(()=>snapshot(doc));
  const guard=()=>{if(options.isCurrent&&!options.isCurrent())throw Error('商品已切换，取消保存');if(doc.querySelector('#polo-review-btn')?.disabled)throw Error('检查或修复尚未结束，取消保存');};
  guard();const active=doc.activeElement;
  if(active&&!active.closest?.('#polo-helper-panel')&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)||active?.isContentEditable)active.blur?.();
  let previous=read(),stable=0;
  for(let i=0;i<30;i++){await pause(150);guard();const current=read();stable=current===previous?stable+150:0;previous=current;if(stable>=750)return {stable:true};}
  throw Error('表单内容仍在变化，未执行保存，请等待填写完成');
 }
 async function request(send,options={}) {
  let timer;const schedule=options.schedule||setTimeout,cancel=options.cancel||clearTimeout;
  try{return await Promise.race([Promise.resolve().then(send),new Promise(resolve=>{timer=schedule(()=>resolve({ok:false,unconfirmed:true,error:'保存请求超时，结果未确认；请先核对商品，勿重复保存'}),20000);})]);}finally{if(timer!==undefined)cancel(timer);}
 }
 window.PoloSaveStability={wait,snapshot,request};
})();
