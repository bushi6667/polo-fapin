const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('chrome_extension/popup-directories.js','utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function popup(storage,picker){
 const elements=new Map();
 for(const id of ['ps-directory-status','ps-directory','choose-ps-directory','save-ps-directory','ps-directory-history'])elements.set(id,{disabled:false,textContent:'',value:'',options:[],addEventListener(event,handler){this[event]=handler;},replaceChildren(...items){this.options=items;this.value='';},add(item){this.options.push(item);}});
 const ctx={Option:function(text,value){this.text=text;this.value=value;},document:{getElementById:id=>elements.get(id)},window:{showDirectoryPicker:picker},PoloDirectories:{get:async()=>storage.handle,history:async()=>storage.entries||[],saveSelection:async h=>{if(storage.fail)throw new Error('存储失败');storage.handle=h;storage.entries=[{name:h.name,handle:h}];}}};
 vm.runInNewContext(source,ctx);return {el:id=>elements.get(id)};
}
(async()=>{
 const storage={handle:null};let permission='granted';
 const h={name:'extracted_images',queryPermission:async()=>permission,requestPermission:async()=>permission};
 let pickerOptions;
 const p=popup(storage,async options=>{pickerOptions=options;return h;});await tick();
 await p.el('choose-ps-directory').click();assert.equal(pickerOptions.startIn,undefined);assert.equal(storage.handle,null);assert.equal(p.el('ps-directory').value,'extracted_images');assert.match(p.el('ps-directory-status').textContent,/点击保存/);
 await p.el('save-ps-directory').click();assert.equal(storage.handle,h);assert.match(p.el('ps-directory-status').textContent,/已保存/);
 permission='prompt';
 const next=popup(storage,async options=>{pickerOptions=options;throw Object.assign(new Error('取消'),{name:'AbortError'});});await tick();assert.equal(next.el('ps-directory').value,h.name);assert.match(next.el('ps-directory-status').textContent,/目录已记住/);assert(!next.el('ps-directory-status').textContent.includes('失效'));assert.equal(next.el('ps-directory-history').options.length,2);
 await next.el('choose-ps-directory').click();assert.equal(pickerOptions.startIn,h);assert.equal(storage.handle,h);
 permission='denied';next.el('ps-directory-history').value='0';next.el('ps-directory-history').change();await next.el('save-ps-directory').click();assert.match(next.el('ps-directory-status').textContent,/未取得读写权限/);assert.equal(storage.handle,h);
 permission='granted';storage.fail=true;await next.el('save-ps-directory').click();assert.match(next.el('ps-directory-status').textContent,/存储失败/);assert.equal(next.el('save-ps-directory').disabled,false);
 const html=fs.readFileSync('chrome_extension/popup.html','utf8');assert(html.includes('class="directory-picker" id="choose-ps-directory"'));assert(!html.includes('authorize-ps-directory'));assert(!html.includes('open-directory-settings'));
 console.log('PASS PS输入框：选择待保存、保存生效、重开恢复、历史切换、取消保留、权限拒绝、存储失败');
})().catch(e=>{console.error(e);process.exitCode=1;});
