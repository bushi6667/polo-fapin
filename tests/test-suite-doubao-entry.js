const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const input={tagName:'TEXTAREA',value:'old',focus(){}};
let controls=[],bad=false,clicks=0;const calls=[];
const img=(src,excluded=false,size=256)=>({src,naturalWidth:320,naturalHeight:256,getBoundingClientRect:()=>({width:size,height:size}),className:'result',closest:sel=>sel==='[class]'?null:excluded?{}:null});
const env={console:{log(){}},location:{href:'https://www.doubao.com/'},URL,Set,Map,Promise,Date,Array,String,Error,
setTimeout:fn=>{queueMicrotask(fn);return 1;},
document:{body:{innerText:''},querySelector:s=>s.includes('contenteditable')?input:s==='button[data-testid="chat_input_send_button"]'?{disabled:false,click(){clicks++;}}:s.includes('loading')?{}:null,
querySelectorAll:s=>s==='button,[role="combobox"]'?controls:s==='img'?[img('https://image/old'),img('https://image/upload',true),img('https://image/sidebar',false,20)]:[]},
chrome:{runtime:{lastError:null,onMessage:{addListener(){}},sendMessage:(r,cb)=>{calls.push(r);if(r.command==='clear')input.value='';if(r.command==='character')input.value+=bad?'X':r.character;cb({success:true});}}}};
env.globalThis=env;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/suite/suite-doubao.js'),'utf8'),env);
(async()=>{
 const api=env.SuiteDoubao;
 assert.strictEqual(api.getAllImageUrls().length,1,'uploaded images never become generated candidates');
 env.fetch=async()=>({ok:true,blob:async()=>new Blob(['real image bytes'],{type:'image/png'})});
 env.FileReader=class{readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result='data:'+blob.type+';base64,'+Buffer.from(b).toString('base64');this.onload();});}};
 env.CustomEvent=class{constructor(type){this.type=type;}};env.document.dispatchEvent=()=>{};
 await assert.rejects(()=>api.materializeImages(['https://image/generated']),/\u65e0\u6c34\u5370/);
 env.getRawUrl=url=>url+(url.includes('?')?'&':'?')+'image_raw=1';
 const copied=await api.materializeImages(['https://image/generated']);
 assert(copied[0].startsWith('data:image/png;base64,'),'page-side materialization removes file:// cross-origin fetch dependency');
 env.fetch=async()=>({ok:false,status:403});
 await assert.rejects(()=>api.materializeImages(['https://image/signed?secret=value']),/HTTP 403/);
 env.fetch=async()=>({ok:true,blob:async()=>new Blob(['not image'],{type:'text/html'})});
 await assert.rejects(()=>api.materializeImages(['https://image/generated']),/不是图片/);
 await api.typePrompt('hello\nworld');assert.strictEqual(input.value,'hello\nworld');
 input.tagName='DIV';Object.defineProperty(input,'innerText',{configurable:true,get(){return input.value.replace(/\n/g,'\n\n');}});
 await api.typePrompt('first line\nsecond line');assert.strictEqual(input.value,'first line\nsecond line','rich editor soft breaks preserve full prompt content');input.tagName='TEXTAREA';
 assert.strictEqual(calls[0].command,'begin');assert.strictEqual(calls[1].command,'clear','attach before clearing');
 bad=true;await assert.rejects(()=>api.typePrompt('same-size'),'same-length corruption rejected');assert.strictEqual(clicks,0);bad=false;
 assert.throws(()=>api.verifySettings({model:'5.0',ratio:'1:1'}),'unknown settings must not silently send');
 controls=['Seedream 4.5','比例 1:1'].map(text=>({innerText:text,getClientRects:()=>[{}]}));
 assert.strictEqual(api.verifySettings({model:'5.0',ratio:'1:1'}).ok,true);
 await api.sendOnce();assert.strictEqual(clicks,1);
 await assert.rejects(()=>api.sendOnce());assert.strictEqual(clicks,1,'replay never clicks send twice');
 console.log('PASS real content functions: full input comparison, attached clear, model/ratio evidence, user/upload exclusion, send replay rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});
