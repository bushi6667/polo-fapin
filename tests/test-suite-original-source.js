// Exercise the real asset resolver at the file:// fetch failure boundary.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'..','发品助手.html'),'utf8');
const source=html.slice(html.indexOf('async function resolveSuiteAssets('),html.indexOf('// 变量解析校验'));
assert(source.includes('async function resolveSuiteAssets'));
async function run(response){
 const requests=[];
 const ctx={Blob,Uint8Array,extensionInstalled:true,currentFileKey:()=> 'one-workbook',
  getColorImagePath:()=>null,
  chrome:{runtime:{sendMessage:(_id,_req,cb)=>cb({ok:false})}},EXTENSION_ID:'test',
  suiteSend:async(action,args)=>{requests.push({action,...args});return response(args.fileName);},
  suiteBlobToDataUrl:async blob=>'data:'+blob.type+';base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64'),
  probeSuiteImage:async(label,url)=>url?.startsWith('data:')?{ok:true,width:10,height:10}:{ok:false,error:'local fetch blocked'}
 };
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const result=await ctx.resolveSuiteAssets({row:12,imagePath:'extracted_images/row12_main.jpg'});
 return {result,requests};
}
(async()=>{
 const good=await run(name=>name.endsWith('.jpg')?{ok:true,data:[1,2,3],type:'image/jpeg'}:{ok:false});
 assert(good.result.assets.main.url.startsWith('data:image/jpeg;base64,'));
 assert.equal(good.result.assets.main.row,12);
 assert.equal(good.result.assets.main.fileKey,'one-workbook');
 assert.equal(good.requests[0].fileName,'row12_main.jpg');
 assert.equal(good.requests.length,1);
 const png=await run(name=>name.endsWith('.png')?{ok:true,data:[4,5],type:'image/png'}:{ok:false,error:'NotFoundError'});
 assert(png.result.assets.main.url.startsWith('data:image/png;base64,'));
 assert.equal(png.requests.length,2);
 const denied=await run(()=>({ok:false,error:'产品原图目录权限不足，请授权'}));
 assert(!denied.result.assets.main);
 assert.equal(denied.requests.length,1,'permission failures must not repeat across extensions');
 assert(denied.result.problems.some(p=>p.includes('权限不足')));
 console.log('PASS local original fetch failure -> extension bytes, same row identity, png fallback and explicit permission failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
