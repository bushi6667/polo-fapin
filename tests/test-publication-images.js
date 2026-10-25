const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');
const env={Blob,btoa};vm.createContext(env);vm.runInContext(fs.readFileSync('chrome_extension/upload/publication-images.js','utf8'),env);
const api=env.PublicationImages,manifest=JSON.parse(fs.readFileSync('chrome_extension/assets/publication-bank/manifest.json','utf8'));
for(const [name,list] of Object.entries(manifest)){
 assert.equal(list.length,4);for(const item of list){const bytes=fs.readFileSync('chrome_extension/assets/publication-bank/'+name+'/'+item.file);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256);}
}
assert.deepEqual(Array.from(api.plan({category:'Non-hooded sweatshirt(5)'.replace(' sweatshirt','-sweatshirt')},'main').keys),['444','111']);
assert.equal(api.category({category:'polo shirt(2)'}),'polo');assert.equal(api.category({_categoryType:'hoodie'}),'hooded-sweatshirt');
assert.equal(api.category({category:'Hooded sweatshirt(4)'}),'hooded-sweatshirt');
assert.throws(()=>api.plan({category:'unknown'},'main'),/类目/);
(async()=>{
 for(const category of Object.keys(manifest)){
  const requested=[],banks=[];const product={category,row:2,_publishFileKey:'same-file'};
  const read=async request=>{requested.push(request);return Array.from(request.keys).reverse().map(key=>({key,dataUrl:'data:image/jpeg;base64,dGVzdA=='}));};
  const bank=async path=>{banks.push(path);return new Blob(['bank'],{type:'image/jpeg'});};
  const main=await api.prepare(product,'main',read,bank);
  assert.equal(main.files.length,6);assert.deepEqual(Array.from(main.files.slice(0,2),f=>f.key),['444','111']);assert.equal(requested[0].fileKey,'same-file');
  assert.deepEqual(banks,Array.from({length:4},(_,i)=>'assets/publication-bank/'+category+'/'+(i+1)+'.jpg'));
  const detail=await api.prepare(product,'detail',read,bank);assert.deepEqual(Array.from(detail.files,f=>f.key),['333','666','222']);
 }
 await assert.rejects(()=>api.prepare({category:'polo',row:2,_publishFileKey:'A'},'main',async()=>[],async()=>null),/缺少/);
 await assert.rejects(()=>api.prepare({category:'polo',row:2},'main',async()=>[],async()=>null),/文件与行号/);
 const source=fs.readFileSync('chrome_extension/content/page3.js','utf8');
 const menu=source.slice(source.indexOf('const items = [',source.indexOf('function createPage3Panel')),source.indexOf('const actionMap =',source.indexOf('function createPage3Panel')));
 assert(menu.indexOf("act: 'fill_detail_template'")<menu.indexOf("act: 'fill_detail_images'"));
 const fill=source.slice(source.indexOf('async function fillAllPage3'),source.indexOf('function createPage3Panel'));
 assert(fill.indexOf('await fillDetailTemplate')<fill.indexOf('await fillDetailImagesPage3'));
 console.log('PASS all five class banks/hash/order, current product identity, six main/three detail, reject missing source, menu and one-click order');
})().catch(e=>{console.error(e);process.exitCode=1;});
