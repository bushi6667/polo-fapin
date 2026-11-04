const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const ctx={window:{},setTimeout};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/content/page3-highlights.js'),'utf8'),ctx);
const api=ctx.window.PoloHighlights;
function fixture(initial=[],fault={}) {
 const commands=[],waits=[];let lis=initial.map(li),count=0,dirty=false,range;
 function li(text){return {textContent:text,childNodes:[{}]};}
 const event=class{constructor(type,options){this.type=type;Object.assign(this,options);}};
 const sel={removeAllRanges(){},addRange(value){range=value;}};
 const doc={activeElement:null,defaultView:{getSelection:()=>sel,KeyboardEvent:event,InputEvent:event},
  querySelector:s=>s.includes('.text-area-list-editor')?editor:s==='#textDesc .length'&&!fault.noCounter?{get textContent(){return count+'/'+(fault.maximum||2000);}}:null,
  createRange:()=>({selectNodeContents(node){this.node=node;},collapse(){},setStart(node){this.start=node;},setEnd(node){this.end=node;}}),
  execCommand(command,_show,value){
   commands.push(command);assert.notEqual(command,'selectAll','禁止全局selectAll');
   if(command==='delete'){assert(lis.includes(range.start)&&lis.includes(range.end),'删除必须限制在列表项内部');lis=[lis[0]];lis[0].textContent='';range={node:lis[0]};dirty=true;return true;}
   assert.equal(command,'insertText');assert(lis.includes(range.node),'插入必须在li内');
   range.node.textContent+=fault.corrupt?value.slice(0,12)+' WRONG':value;dirty=true;return true;
  }};
 const editor={isConnected:true,getBoundingClientRect:()=>({height:100}),scrollIntoView(){},contains(node){return lis.includes(node);},
  get innerText(){return fault.ghost||(lis.map(x=>x.textContent).join('\n')+(fault.extraText?'\n'+fault.extraText:''));},get textContent(){return this.innerText;},
  querySelector:()=>lis[0],querySelectorAll:()=>lis,
  focus(){if(fault.noFocus)return;doc.activeElement=editor;if(!lis.length&&!fault.ghost){lis=[li('')];range={node:lis[0]};}},
  blur(){doc.activeElement=null;if(fault.blurDrops&&lis.some(x=>x.textContent)){lis=[];dirty=true;}},
  dispatchEvent(e){if(e.type==='input')dirty=true;
   if(e.type==='keydown'&&e.key==='Enter'&&!fault.noEnter){const next=li('');lis.splice(lis.indexOf(range.node)+1,0,next);range={node:next};}
  }};
 const commit=()=>{if(!fault.frozenCounter)count=lis.map(x=>x.textContent.trim()).filter(Boolean).join('\n').replace(/\n/g,'**').length;};commit();
 return {doc,editor,commands,waits,items:()=>lis.map(x=>x.textContent),
  options:{click:async e=>e.focus(),wait:async ms=>{waits.push(ms);if(ms>=500&&dirty){commit();dirty=false;}}},
  userFill(value){lis=[li(value)];commit();}};
}
(async()=>{
 let f=fixture();assert.equal(api.inspect(f.doc).state,'fail');
 const written=await api.write(f.doc,['First full description','Second full description'],f.options);
 assert.equal(written.count,2);assert.deepEqual(f.items(),['First full description','Second full description']);assert(f.waits.filter(x=>x>=500).length>=2);
 f=fixture(['Original custom text']);await api.write(f.doc,['New complete description'],{...f.options,mode:'append'});
 assert.deepEqual(f.items(),['Original custom text','New complete description']);assert(!f.commands.includes('delete'));
 f=fixture(['Old one','Old two']);await api.write(f.doc,['New one','New two'],f.options);
 assert.deepEqual(f.items(),['New one','New two']);assert.equal(f.commands.filter(x=>x==='delete').length,1);
 f=fixture(['Preserve me']);assert.equal((await api.write(f.doc,['Default'],{...f.options,missingOnly:true})).skipped,true);assert.equal(f.commands.length,0);
 f=fixture();assert.equal((await api.write(f.doc,['Default'],{...f.options,missingOnly:true,click:async()=>f.userFill('User arrived')})).skipped,true);assert.deepEqual(f.items(),['User arrived']);
 f=fixture([],{ghost:'Visible DOM without ul/li'});assert.equal(api.inspect(f.doc).state,'unknown');
 await assert.rejects(api.write(f.doc,['Default'],f.options),/DOM/);assert.equal(f.commands.length,0);
 f=fixture(['Valid list text'],{extraText:'Uncommitted outside text'});assert.equal(api.inspect(f.doc).state,'unknown');
 await assert.rejects(api.write(f.doc,['Default'],{...f.options,missingOnly:true}),/列表外|正文/);assert.equal(f.commands.length,0);
 f=fixture(['Already over the maximum'],{maximum:5});
 await assert.rejects(api.write(f.doc,['New'],{...f.options,missingOnly:true}),/上限/);assert.deepEqual(f.items(),['Already over the maximum']);assert.equal(f.commands.length,0);
 f=fixture([],{noCounter:true});assert.equal(api.inspect(f.doc).state,'unknown');await assert.rejects(api.write(f.doc,['Default'],f.options),/计数器/);
 f=fixture([],{noFocus:true});await assert.rejects(api.write(f.doc,['Default'],f.options),/焦点/);assert.equal(f.commands.length,0);
 f=fixture([],{noEnter:true});await assert.rejects(api.write(f.doc,['One','Two'],f.options),/下一条/);
 f=fixture([],{frozenCounter:true});await assert.rejects(api.write(f.doc,['Default'],f.options),/完整复核/);
 f=fixture([],{corrupt:true});await assert.rejects(api.write(f.doc,['Same initial twelve characters then accurate ending'],f.options),/完整复核/,'不能仅比较开头12字符');
 f=fixture([],{blurDrops:true});await assert.rejects(api.write(f.doc,['Default'],f.options),/完整复核/,'失焦丢失不能报成功');
 f=fixture([],{maximum:5});await assert.rejects(api.write(f.doc,['Too long to insert'],f.options),/上限/);assert.equal(f.commands.length,0);
 f=fixture();let current=true;await assert.rejects(api.write(f.doc,['Default'],{...f.options,isCurrent:()=>current,click:async()=>{current=false;}}),/商品已切换/);assert.equal(f.commands.length,0);
 console.log('PASS highlights: platform lists, bounded editing, full text/count/blur verification, missing-only races, no ghost success');
})().catch(e=>{console.error(e);process.exitCode=1;});
