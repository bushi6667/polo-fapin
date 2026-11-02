const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/content/page3-review-colors.js'),'utf8'),ctx);
const {inspect,repair}=ctx.window.PoloReviewColors;
function color(label,loaded){const row={loaded,querySelectorAll(){return this.loaded?[{getAttribute:()=>'/saved-image.jpg'}]:[];}};const input={value:label,closest:()=>row};return {input,row};}
(async()=>{
 const white=color('White',false),black=color('Black',true),doc={querySelectorAll:()=>[white.input,black.input]};
 assert.equal(inspect(doc).state,'fail');let reads=0,uploads=0;
 const api={read:async key=>{reads++;assert.equal(key,'white');return {ok:true,url:'local',fromDisk:true};},upload:async target=>{uploads++;assert.equal(target.input,white.input);white.row.loaded=true;return {ok:true};}};
 await repair(doc,{},api);assert.equal(reads,1);assert.equal(uploads,1);assert.equal(inspect(doc).state,'pass');assert.equal(white.input.value,'White');assert.equal(black.input.value,'Black');assert.equal(black.row.loaded,true);
 await repair(doc,{},api);assert.equal(uploads,1,'已有图不重复上传');
 const green=color('Green',false),customDoc={querySelectorAll:()=>[green.input]};
 await assert.rejects(repair(customDoc,{},api),/无明确图片来源/);
 white.row.loaded=false;
 await assert.rejects(repair(doc,{}, {...api,read:async()=>({ok:true,url:'cached',fromDisk:false})}),/不使用旧缓存/);
 await repair(doc,{}, {...api,read:async()=>{white.row.loaded=true;return {ok:true,url:'local',fromDisk:true};}});
 assert.equal(uploads,1,'读取期间图片已补回，不覆盖');
 console.log('PASS color image repair: one missing only, preserve names/existing images, reject unknown/cache, reread before upload');
})().catch(e=>{console.error(e);process.exitCode=1;});
