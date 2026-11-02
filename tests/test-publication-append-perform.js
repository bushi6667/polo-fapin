const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
function env(names){
 const state={deletes:0,uploads:0,items:[]};
 const item=name=>{const img={complete:true,naturalWidth:20,src:'saved://'+name};return {innerText:name,contains:()=>false,querySelector:s=>s==='img'?img:null,querySelectorAll:s=>s==='img'?[img]:[]};};
 state.items=names.map(item);
 const input={files:[],dispatchEvent(event){if(event.type==='change'){state.uploads++;for(const file of this.files)state.items.push(item(file.name));}}};
 const remove={getClientRects:()=>[{}],matches:()=>true,textContent:'删除全部',click(){state.deletes++;throw Error('test detected deletion');}};
 const area={scrollIntoView(){},dispatchEvent(){},querySelector(s){return s.includes('input[type="file"]')?input:null;},querySelectorAll(s){return s.includes('button')?[remove]:state.items;}};
 class Transfer{constructor(){const list=[];this.items={add:file=>list.push(file)};this.files=list;}}
 class E{constructor(type){this.type=type;}}
 const ctx={Blob,File,fetch,location:{href:'https://post.alibaba.com/product/publish.htm'},DataTransfer:Transfer,Event:E,MouseEvent:E,setTimeout:fn=>setTimeout(fn,0),chrome:{runtime:{sendMessage:async()=>({})}},document:{documentElement:{dataset:{}},querySelector:s=>s==='#scImages'?area:null,querySelectorAll:()=>[]}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/upload/publication-dom.js'),'utf8'),ctx);
 return {api:ctx.PublicationDom,state};
}
const files=['444','111','bank_1','bank_2','bank_3','bank_4'].map(key=>({name:key+'.jpg',dataUrl:'data:image/jpeg;base64,aW1hZ2U='}));
(async()=>{
 const {api,state}=env(files.slice(0,5).map(f=>f.name)),existing=state.items.slice();
 const result=await api.perform('main',files,{appendOnly:true});
 assert.equal(result.count,6);assert.equal(result.appended,1);assert.equal(state.deletes,0);assert.equal(state.uploads,1);
 existing.forEach((item,i)=>assert.equal(state.items[i],item,'已有五张图片必须原样保留'));
 await api.perform('main',files,{appendOnly:true});assert.equal(state.uploads,1,'连续检查不重复上传');
 const unknown=env(['unknown.jpg']);
 await assert.rejects(unknown.api.perform('main',files,{appendOnly:true}),/无法可靠识别/);
 assert.equal(unknown.state.deletes,0);assert.equal(unknown.state.uploads,0);
 const changed=env(files.slice(0,5).map(f=>f.name));
 await assert.rejects(changed.api.perform('main',files,{appendOnly:true,expectedPageUrl:'https://post.alibaba.com/product/publish.htm?itemId=other'}),/页面已切换/);
 assert.equal(changed.state.deletes,0);assert.equal(changed.state.uploads,0);
 const legacy=env(files.slice(0,5).map(f=>f.name));
 await assert.rejects(legacy.api.perform('main',files),/test detected deletion/);
 assert.equal(legacy.state.deletes,1,'测试必须能捕获旧替换路径，否则保护断言无效');
 console.log('PASS actual uploader append branch: preserve five objects, append one, no duplicate, unknown identity untouched, deletion tripwire verified');
})().catch(e=>{console.error(e);process.exitCode=1;});
