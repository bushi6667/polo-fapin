const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
(async()=>{
 const html=fs.readFileSync('chrome_extension/popup.html','utf8');
 for(const kind of ['helper','color','ps','scripts']){assert(html.includes('data-path-setting="'+kind+'"'));assert(!html.includes('data-path-setting="'+kind+'" open'));}
 assert(html.includes('.path-setting[open] .path-filled {display:none;}'));
 const els=new Map();for(const kind of ['helper','color','ps','scripts'])els.set(kind+'-filled',{textContent:'',classList:{toggle(c,v){this.empty=v;}}});
 let config={polo_helper_path:'file:///C:/助手.html',polo_color_img_dir:''},ps=null,changed,saved;
 const ctx={console,chrome:{storage:{local:{get:async()=>config},onChanged:{addListener:fn=>changed=fn}}},PoloDirectories:{get:async()=>ps,pickerRecord:async()=>null},window:{addEventListener:(event,fn)=>saved=fn},document:{getElementById:id=>els.get(id)}};
 vm.runInNewContext(fs.readFileSync('chrome_extension/popup-path-sections.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.equal(els.get('helper-filled').textContent,'已填写');assert.equal(els.get('helper-filled').classList.empty,false);assert.equal(els.get('color-filled').textContent,'未填写');assert.equal(els.get('color-filled').classList.empty,true);assert.equal(els.get('ps-filled').textContent,'未填写');
 config={polo_helper_path:'',polo_color_img_dir:'polo-dir:A'};changed({polo_helper_path:{},polo_color_img_dir:{}},'local');await new Promise(r=>setImmediate(r));assert.equal(els.get('helper-filled').textContent,'未填写');assert.equal(els.get('color-filled').textContent,'已填写');
 ps={name:'extracted_images'};await saved();assert.equal(els.get('ps-filled').textContent,'已填写');console.log('PASS 三项配置默认收起、展开隐藏状态、保存后红绿状态更新、PS写入通知');
})().catch(e=>{console.error(e);process.exitCode=1;});
