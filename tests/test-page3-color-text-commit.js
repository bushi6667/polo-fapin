const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../chrome_extension/content/page3.js'),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('        if (targetInput.value !== color.label) {',source.indexOf('async function fillColorsPage3'));
const end=source.indexOf('\n        targetItem = targetInput.closest',start);
assert(start>0&&end>start);
const step=source.slice(start,end);
async function scenario(initial,dropTyping=false){
 let clicks=0,setters=0;const row={},results=[];
 const input={value:initial,scrollIntoView(){},focus(){doc.activeElement=this;},select(){},blur(){doc.activeElement=null;},setSelectionRange(){},closest:()=>row,dispatchEvent(){}};
 const doc={activeElement:null,body:{dispatchEvent(){}},execCommand(command,_flag,text){if(command==='delete')input.value='';if(command==='insertText'&&!dropTyping)input.value+=text;}};
 const ctx={input,row,results,document:doc,getColorInputs:()=>[input],sleep3:async()=>{},realClick:async()=>{clicks++;},
  commitFieldByClick:async()=>{input.value='';},setInputValue:(e,value)=>{setters++;e.value=value;},log(){},KeyboardEvent:class{},MouseEvent:class{}};
 vm.createContext(ctx);
 await vm.runInContext('(async()=>{for(let i=0;i<1;i++){let targetInput=input,targetItem=row;const color={label:"White"};'+step+'}})()',ctx);
 return {value:input.value,clicks,setters,results};
}
(async()=>{
 const typed=await scenario('');assert.equal(typed.value,'White');assert.equal(typed.clicks,1);assert.equal(typed.results.length,0);
 const existing=await scenario('White');assert.equal(existing.value,'White');assert.equal(existing.clicks,0);assert.equal(existing.setters,0);
 const recovery=await scenario('',true);assert.equal(recovery.value,'White');assert.equal(recovery.setters,1);assert.equal(recovery.results.length,0);
 console.log('PASS color text commit: preserve existing, blur without clearing click, recover dropped typing');
})().catch(e=>{console.error(e);process.exitCode=1;});
