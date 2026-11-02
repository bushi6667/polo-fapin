const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/content/page3-review-faq.js'),'utf8'),ctx);
const {plan,appendMissing}=ctx.window.PoloReviewFaq;
function row(q='',a=''){const question={value:q},answer={value:a};return {q:question,a:answer,querySelector:s=>s.includes('question')?question:answer};}
const wanted=[{q:'Question 1',a:'Answer 1'},{q:'Question 2',a:'Answer 2'},{q:'Question 3',a:'Answer 3'}];
(async()=>{
 const rows=[row('Question 1','Custom answer 1'),row('Question 3','Answer 3')];
 const add={scrollIntoView(){},click(){rows.push(row());}};
 const doc={querySelectorAll:()=>rows,querySelector:()=>({querySelector:()=>add})};
 assert.deepEqual(Array.from(plan(doc,wanted).missingPairs,f=>f.q),['Question 2']);
 let writes=0;
 await appendMissing(doc,wanted,{click:async e=>e.click(),write:async fields=>{for(const [input,value] of fields){assert.equal(input.value,'');input.value=value;writes++;}},wait:async()=>{}});
 assert.equal(writes,2);assert.equal(rows[0].a.value,'Custom answer 1');assert.equal(rows[1].q.value,'Question 3');assert.equal(rows[2].q.value,'Question 2');
 assert.equal(plan(doc,wanted).missingPairs.length,0);
 await appendMissing(doc,wanted,{click:async()=>{throw Error('不应重复新增');},write:async()=>{throw Error('不应重复写入');}});
 // 写问题后模拟平台替换整行，旧答案对象绝不能继续写。
 const rerenderRows=[row('Question 1','Answer 1'),row('Question 3','Answer 3')];
 let staleAnswer;
 const rerenderAdd={scrollIntoView(){},click(){const r=row();staleAnswer=r.a;rerenderRows.push(r);}};
 const rerenderDoc={querySelectorAll:()=>rerenderRows,querySelector:()=>({querySelector:()=>rerenderAdd})};
 await appendMissing(rerenderDoc,wanted,{click:async e=>e.click(),wait:async()=>{},write:async fields=>{
   for(const [input,value] of fields){assert.notEqual(input,staleAnswer,'不得写旧答案框');input.value=value;
     if(value==='Question 2')rerenderRows[2]=row(value,'');
   }
 }});
 assert.equal(rerenderRows[2].a.value,'Answer 2');assert.equal(staleAnswer.value,'');
 for(const scenario of ['user-answer','switch-product','duplicate-question']) {
   const changing=[row('Question 1','Answer 1'),row('Question 3','Answer 3')];
   let current=true,answerWrites=0;
   const changingAdd={scrollIntoView(){},click(){changing.push(row());}};
   const changingDoc={querySelectorAll:()=>changing,querySelector:()=>({querySelector:()=>changingAdd})};
   const action=appendMissing(changingDoc,wanted,{click:async e=>e.click(),wait:async()=>{},isCurrent:()=>current,write:async fields=>{
     for(const [input,value] of fields){input.value=value;
       if(value==='Question 2') {
         if(scenario==='user-answer')changing[2]=row(value,'User typed answer');
         if(scenario==='switch-product')current=false;
         if(scenario==='duplicate-question')changing.push(row(value,'Keep duplicate answer'));
       } else answerWrites++;
     }
   }});
   if(scenario==='user-answer'){await action;assert.equal(changing[2].a.value,'User typed answer');}
   else await assert.rejects(action,scenario==='switch-product'?/已切换/:/身份不唯一/);
   assert.equal(answerWrites,0,scenario+' must not write an answer');
   assert.equal(changing[0].a.value,'Answer 1');assert.equal(changing[1].a.value,'Answer 3');
 }
 const emptyRows=[row()];
 const emptyDoc={querySelectorAll:()=>emptyRows};
 const emptyPlan=plan(emptyDoc,[wanted[0]]);
 const oldAnswer=emptyRows[0].a;
 emptyRows[0]=row('Question 1','');
 assert.equal(emptyPlan.targets.find(t=>t[2]==='FAQ答案')[3](),emptyRows[0].a);
 assert.notEqual(emptyPlan.targets.find(t=>t[2]==='FAQ答案')[3](),oldAnswer);
 emptyRows[0].a.value='User changed answer';
 assert.equal(emptyPlan.targets.find(t=>t[2]==='FAQ答案')[3](),null,'用户已有内容时旧计划不能再写');
 for(const initial of [[row(),row(),row('Question 3','Custom existing answer')],[row(),row(),row()]]) {
   const live=initial;
   const liveDoc={querySelectorAll:()=>live};
   const targets=plan(liveDoc,wanted).targets;
   assert.equal(targets.length,initial[2].q.value?4:6,'应能识别多条全空行的缺失源问答');
   for(const t of targets){const input=t[3]();assert(input,'每步都应重新找到唯一空字段');input.value=t[1];
     for(let i=0;i<live.length;i++)live[i]=row(live[i].q.value,live[i].a.value);
   }
   assert.equal(live[0].q.value,'Question 1');assert.equal(live[1].q.value,'Question 2');
   assert.equal(live[0].a.value,'Answer 1');assert.equal(live[1].a.value,'Answer 2');
 }
 const customWithBlank={querySelectorAll:()=>[row('User custom question','User answer'),row(),row('Question 3','Answer 3')]};
 assert.equal(plan(customWithBlank,wanted).targets.length,0,'自定义问题使缺失源不唯一，不猜填空行');
 const reordered=[row('Question 3','Custom answer'),row(),row('Question 1','Answer 1')];
 const reorderedPlan=plan({querySelectorAll:()=>reordered},wanted);
 assert.equal(reorderedPlan.targets[0][1],'Question 2','按剩余源而不是行号填');
 const sharedWanted=[{q:'Unique question A',a:'Shared answer'},{q:'Unique question B',a:'Shared answer'}];
 const sharedRows=[row(),row()],sharedDoc={querySelectorAll:()=>sharedRows};
 for(const t of plan(sharedDoc,sharedWanted).targets){const input=t[3]();assert(input);input.value=t[1];}
 assert.equal(sharedRows[0].q.value,'Unique question A');assert.equal(sharedRows[1].q.value,'Unique question B');
 assert.equal(sharedRows[0].a.value,'Shared answer');assert.equal(sharedRows[1].a.value,'Shared answer');
 const duplicateExisting={querySelectorAll:()=>[row('Question 1','Answer 1'),row('Question 1','Answer 1'),row()]};
 assert.equal(plan(duplicateExisting,wanted).targets.length,0,'已有重复问题时不能给空行猜配来源');
 const customDoc={querySelectorAll:()=>[row('User question','User answer')]};
 assert.equal(plan(customDoc,wanted).missingPairs.length,0,'身份不唯一，不按数量补重复问题');
 const blankDoc={querySelectorAll:()=>[row()]};
 assert.equal(plan(blankDoc,wanted).targets.length,2,'全空默认行可按源补第一条');
 const ambiguousDoc={querySelectorAll:()=>[row('Same question','')]};
 const ambiguous=plan(ambiguousDoc,[{q:'Same question',a:'Answer A'},{q:'Same question',a:'Answer B'}]);
 assert.equal(ambiguous.targets.length,0,'同问题有两种源答案，不能猜填');assert.equal(ambiguous.unresolved,1);
 const lost=[row('Question 1','Answer 1')];
 const doubleAdd={scrollIntoView(){},click(){lost.push(row(),row());}};
 const brokenDoc={querySelectorAll:()=>lost,querySelector:()=>({querySelector:()=>doubleAdd})};
 await assert.rejects(appendMissing(brokenDoc,wanted,{click:async e=>e.click(),write:async()=>{throw Error('不应填不唯一的行');},wait:async()=>{}}),/结果不唯一/);
 console.log('PASS FAQ append: identify missing pair, preserve custom answers/order, no duplicate retry, no ambiguous append');
})().catch(e=>{console.error(e);process.exitCode=1;});
