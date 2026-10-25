const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const overlay=fs.readFileSync('chrome_extension/js代码/444叠加后处理.js','utf8');
const selected={cardImage:{name:'configured.png',value:'data:image/png;base64,dGVzdA=='}};
const saved={polo:[{key:'444',postprocess:[
 {name:'444叠加后处理.js',code:'// [444叠加] 已用当前产品行生成属性卡',resourceValues:selected},
 {name:'444扩图.js',code:'expansion-original'}
]}]};
const env={console,Blob,document:{addEventListener(){}},localStorage:{getItem:()=>JSON.stringify(saved)}};
env.window=env;env.globalThis=env;
vm.createContext(env);
for(const f of ['category-field-rules.js','excel-row.js','custom-js-data.js','script-contract-parser.js','custom-step-defaults.js','custom-step-builtin-scripts.js','custom-step-config.js','chrome_extension/suite/suite-postprocess.js'])vm.runInContext(fs.readFileSync(f,'utf8'),env);
const migrated=env.CustomStepConfig.stepsForCategory('polo')[0];
assert.deepEqual(Array.from(migrated.postprocess,s=>s.name),['444扩图.js','444叠加后处理.js']);
assert.equal(migrated.postprocess[1].code,overlay);
assert.deepEqual(JSON.parse(JSON.stringify(migrated.postprocess[1].resourceValues)),selected,'升级必须保留已选图片');
const requirement=env.ScriptContractParser.requirements(overlay,'polo');
assert.equal(requirement.columns.length,0,'图片叠加不应依赖Excel属性');
assert(!requirement.resources.find(r=>r.key==='cardImage').optional);
const surfaces=[],draws=[];
env.Image=class{set src(value){assert.equal(value,selected.cardImage.value);this.onload();}};
const steps={key:'444',postprocess:[
 {name:'444扩图.js',code:'CustomJsSDK.run(async ctx=>new Blob(["expanded"],{type:"image/png"}));'},
 {name:'444叠加后处理.js',code:overlay,resourceValues:selected}
]};
(async()=>{
 const result=await env.SuitePostprocess.runStep(steps,'444',new Blob(['original']),{
  createSurface:async input=>{
   const source=await input.text();surfaces.push(source);
   return {canvas:{width:200,height:200},ctx:{drawImage(){draws.push(source);}},toBlob:async()=>new Blob([source+'+overlay'],{type:'image/png'}),dispose(){}};
  }
 });
 assert(result.ok,result.error);assert.equal(await result.output.text(),'expanded+overlay');
 assert.deepEqual(surfaces,['original','expanded']);assert.deepEqual(draws,['expanded']);
 assert.equal(result.applied,'customJs+customJs');
 const missing=env.SuitePostprocess.checkAvailability([{...steps,postprocess:[{name:'444叠加后处理.js',code:overlay}]}],['444'],()=>false);
 assert.equal(missing.ok,false);assert(missing.problems.some(p=>p.includes('白底卡片图')));
 // 不透明 JPG 右侧白色留空不能盖住衣服；裁切后仍按原版式比例定位。
 let execute;const pixels=new Uint8ClampedArray(10*10*4);
 for(let y=0;y<10;y++)for(let x=0;x<10;x++){const i=(y*10+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=x<3?230:255;pixels[i+3]=255;}
 const crop=[];
 vm.runInNewContext(overlay,{
  CustomJsSDK:{run:fn=>{execute=fn;}},
  Image:class{constructor(){this.naturalWidth=10;this.naturalHeight=10;}set src(v){this.onload();}},
  document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels})})})}
 });
 await execute({canvas:{width:200,height:200},ctx:{drawImage:(...args)=>crop.push(args.slice(1))},data:{hasResource:async()=>true,loadResource:async()=>selected.cardImage.value},log(){}});
 assert.deepEqual(crop,[[0,0,3,10,0,0,60,200]],'只叠加左侧内容，右侧白色区域不能覆盖扩图结果');
 console.log('PASS 444: migrate old fallback, preserve selected image, expand before actual overlay script, reject missing overlay resource');
})().catch(e=>{console.error(e);process.exitCode=1;});
