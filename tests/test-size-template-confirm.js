const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const moduleSource=fs.readFileSync(__dirname+'/../chrome_extension/content/page3-review-size.js','utf8');
const pageSource=fs.readFileSync(__dirname+'/../chrome_extension/content/page3.js','utf8');
function fixture(options={}){
 let active=false,clicks=0,waits=0,esc=0;
 const inputs=[{value:''},{value:''}];
 const button={innerText:'确定',disabled:false,getBoundingClientRect:()=>({left:10,top:10,width:20,height:20}),
  closest:()=>button,click(){clicks++;if(!options.stuck){active=false;if(!options.noData)inputs.forEach(e=>e.value='43');}}};
 const dialog={textContent:options.unknown?'其他操作':'清除尺码表数据 请确认是否清空尺码表数据',
  getBoundingClientRect:()=>({height:active?100:0}),querySelectorAll:()=>[button]};
 const trigger={offsetHeight:10,scrollIntoView(){}},option={innerText:'男士卫衣通用版',offsetHeight:10,scrollIntoView(){}};
 const labels=['S','M','L','Xl','2 XL','3 XL'].map(text=>{
  const input={checked:true},wrapper={querySelector:s=>s==='input'?input:{textContent:text},closest:()=>null,
   click(){throw Error('不得重复切换已有尺码');}};
  return {innerText:text,closest:()=>wrapper,wrapper};
 });
 const doc={querySelector:s=>s.includes('next-select-trigger')?trigger:{},
  querySelectorAll:s=>s.includes('td[required]')?inputs:s.includes('alertdialog')?[dialog]:s==='.next-checkbox-wrapper'?labels.map(e=>e.wrapper):s.includes('next-checkbox-label')?labels:s.includes('next-menu-item')?[option]:[],
  elementFromPoint:()=>options.covered?{closest:()=>null}:button,body:{click(){}}};
 const logs=[],c={window:{},document:doc,log:(...x)=>logs.push(x),sleep3:async()=>{waits++;},
  scrollAndFind:async fn=>fn(),realClick:async e=>{if(e===option)active=true;},waitDialogsGone:async()=>{esc++;throw Error('不得使用ESC清理');}};
 vm.createContext(c);vm.runInContext(moduleSource,c);
 const start=pageSource.indexOf('async function fillSizeTemplate('),end=pageSource.indexOf('\n// ============================================================',start);
 vm.runInContext(pageSource.slice(start,end),c);
 return {c,doc,inputs,button,logs,activate:()=>active=true,stats:()=>({clicks,waits,esc}),
  fill:()=>c.fillSizeTemplate({category:'Hooded sweatshirt(4)'},undefined,{missingOnly:true,isCurrent:()=>true})};
}
(async()=>{
 let f=fixture();const result=await f.fill();assert(result.some(x=>x.includes('尺码模板:')));assert.equal(f.stats().clicks,1);assert.equal(f.stats().esc,0);
 assert(f.inputs.every(e=>e.value==='43'));assert(f.logs.some(x=>x[1]==='success'&&x[0].includes('实际测量值')));
 const snapshot=JSON.stringify(f.inputs);await assert.rejects(f.fill(),/已有内容/);assert.equal(JSON.stringify(f.inputs),snapshot);assert.equal(f.stats().clicks,1);
 for(const options of [{stuck:true},{noData:true},{unknown:true},{covered:true}]){
  f=fixture(options);await assert.rejects(f.fill(),/未完成|未完整|未知|遮挡/);
  assert(f.stats().clicks<=1);assert.equal(f.stats().esc,0);assert(!f.logs.some(x=>x[1]==='success'));
 }
 f=fixture();f.activate();await assert.rejects(f.c.window.PoloReviewSize.confirmTemplate(f.doc,{wait:async()=>{},canConfirm:()=>{throw Error('已有自定义测量');}}),/自定义/);assert.equal(f.stats().clicks,0);
 f=fixture();await assert.rejects(f.c.window.PoloReviewSize.waitMeasurements(f.doc,{wait:async()=>{},isCurrent:()=>false}),/切换/);
 f=fixture();let ticks=0;await f.c.window.PoloReviewSize.waitMeasurements(f.doc,{wait:async()=>{if(++ticks===3)f.inputs.forEach(e=>e.value='55');}});assert.equal(ticks,3);
 f=fixture();ticks=0;await f.c.window.PoloReviewSize.confirmTemplate(f.doc,{wait:async()=>{if(++ticks===10)f.activate();}});assert.equal(f.stats().clicks,1);
 console.log('PASS real fillSizeTemplate + confirmation: one scoped native confirm, no ESC, wait actual numbers, no false success, preserve existing sizes/data, timeout/unknown/covered/racing identity');
})().catch(e=>{console.error(e);process.exitCode=1});
