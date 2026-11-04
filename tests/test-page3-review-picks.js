const assert=require('assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const ctx={window:{},setTimeout};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/content/page3-review-picks.js'),'utf8'),ctx);
const repair=ctx.window.PoloReviewPicks.repair;
function fixture(values=['']){
 let inputs=values.map(value=>({value,blur(){}})),addClicks=0,colorClicks=0,sizeClicks=0,writes=0;
 const add={scrollIntoView(){this.visible=true}};
 const boxes=['S','M','L','Xl','2 XL','3 XL'].map(text=>({state:{checked:false},closest:()=>null,querySelector(s){return s==='input'?this.state:{textContent:text}}}));
 const doc={querySelector:()=>add,querySelectorAll:s=>s.includes('colorCombobox')?inputs:boxes};
 const api={wait:async()=>{},click:async e=>{
  if(e===add){addClicks++;assert(e.visible,'add must scroll before real click');inputs.push({value:'',blur(){}});}
  else if(e&&e.state){sizeClicks++;e.state.checked=!e.state.checked;}
  else colorClicks++;
 },set:(e,v)=>{writes++;e.value=v;}};
 return {doc,api,boxes,inputs,add,stats:()=>({addClicks,colorClicks,sizeClicks,writes})};
}
(async()=>{
 // 全空一行：补建到四行并填四个默认色；逐色点击+写入。
 let f=fixture();await repair('fill_colors',f.doc,f.api);
 assert.deepEqual(f.inputs.map(e=>e.value),['White','Black','Gray','Navy']);
 assert.equal(f.stats().addClicks,3);assert.equal(f.stats().colorClicks,4);assert.equal(f.stats().writes,4);
 // 重复执行：已有内容不重写、不重新点击。
 await repair('fill_colors',f.doc,f.api);
 assert.equal(f.stats().addClicks,3);assert.equal(f.stats().colorClicks,4);assert.equal(f.stats().writes,4,'repeat must not rewrite');
 // 部分缺失：保留自定义 Custom，只给空行补默认色。
 f=fixture(['Custom','']);const partial=await repair('fill_colors',f.doc,f.api);
 assert.deepEqual(f.inputs.map(e=>e.value),['Custom','White','Black','Gray']);
 assert.equal(partial.preserved,1);
 assert.equal(f.stats().writes,3);
 // 商品已切换：不点击、不写入。
 f=fixture();await assert.rejects(repair('fill_colors',f.doc,{...f.api,isCurrent:()=>false}),/切换/);
 assert.equal(f.stats().addClicks,0);assert.equal(f.stats().writes,0);
 // 点击输入框后用户填入自定义值：停止补填，保留用户值。
 // 补填过程中行数变化：立即停止，避免按旧下标写错行。
 f=fixture(['Custom','']);const origColorClick=f.api.click;
 f.api.click=async e=>{if(e!==f.add)f.inputs.pop();else await origColorClick(e);};
 await assert.rejects(repair('fill_colors',f.doc,f.api),/颜色行数变化/);
 f=fixture();const original=f.api.click;
 f.api.click=async e=>{await original(e);if(e!==f.add&&!e.state)f.inputs[0].value='User';};
 await assert.rejects(repair('fill_colors',f.doc,f.api),/变化/);
 assert.equal(f.inputs[0].value,'User');assert.equal(f.stats().writes,0);
 // 尺码：全空选六码；重复不重复点击；已有部分选中只补缺失且不取消；缺控件报错。
 f=fixture();await repair('fill_sizes',f.doc,f.api);assert(f.boxes.every(e=>e.state.checked));
 assert.equal(f.stats().sizeClicks,6);
 await repair('fill_sizes',f.doc,f.api);assert.equal(f.stats().sizeClicks,6);
 f=fixture();f.boxes[0].state.checked=true;
 const partialSizes=await repair('fill_sizes',f.doc,f.api);
 assert.equal(partialSizes.written,5,'只补5个未选尺码');assert.equal(partialSizes.preserved,1);
 assert(f.boxes.every(e=>e.state.checked));assert.equal(f.stats().sizeClicks,5,'已选尺码不重复点击');
 f=fixture();f.boxes.pop();await assert.rejects(repair('fill_sizes',f.doc,f.api),/缺失/);assert.equal(f.stats().sizeClicks,0);
 console.log('PASS controlled picks: partial colors preserve custom, only empty rows filled, races, six sizes, missing controls');
})().catch(e=>{console.error(e);process.exitCode=1});
