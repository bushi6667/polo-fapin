const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let saved={};const env={window:{},console,Blob,document:{addEventListener(){}},localStorage:{getItem:()=>JSON.stringify(saved)}};env.globalThis=env;vm.createContext(env);
for(const f of ['category-field-rules.js','excel-row.js','script-contract-parser.js','custom-step-defaults.js','custom-step-builtin-scripts.js','custom-step-config.js','chrome_extension/suite/suite-postprocess.js'])vm.runInContext(fs.readFileSync(f,'utf8'),env);
const w=env.window,api=w.CustomStepConfig,post=vm.runInContext('SuitePostprocess',env);
(async()=>{
 for(const [category,key] of [['polo','polo'],['shirt','shirt'],['t-shirt','tshirt'],['hooded-sweatshirt','hoodie'],['non-hooded-sweatshirt','sweatshirt']]){
  const steps=api.stepsForCategory(category);
  assert.equal(steps.length,5);
  assert.deepEqual(Array.from(steps.find(s=>s.key==='444').postprocess,s=>s.name),['444扩图.js','444叠加后处理.js']);
  for(const step of steps)for(const script of step.postprocess)assert.equal(script.code,w.CustomStepBuiltinScripts[script.name]);
  assert(steps.find(s=>s.key==='444').postprocess[1].resourceValues.cardImage.value.startsWith('data:image/jpeg;base64,'));
  const headers=Array.from(w.CategoryFieldRules.columnsOf(category));
  const row=w.ExcelRow.build({fileName:category+'.xlsx',sheetName:'S',rowNumber:8,headers,values:headers.map(h=>h==='类目'?category:h==='面料克重'?'300 / 300克':h==='标题'?'Custom Cotton Clothing / 定制服装':'Cotton / 棉')});
  const result=await post.checkInputs(steps,steps.map(s=>s.key),row);assert.equal(result.ok,true,JSON.stringify(result));
  saved[key]=JSON.parse(JSON.stringify(steps));
  for(const step of saved[key])for(const script of step.postprocess){script.code='';delete script.resourceValues;}
  const repaired=api.stepsForCategory(category);assert.equal(post.checkConfig(repaired,repaired.map(s=>s.key)).ok,true);
 }
 const custom=saved.shirt[0].postprocess[0];custom.code='// user custom script';
 saved.shirt.find(s=>s.key==='444').postprocess[1].resourceValues={cardImage:{name:'user.png',value:'data:image/png;base64,YQ=='}};
 const preserved=api.stepsForCategory('shirt');assert.equal(preserved[0].postprocess[0].code,custom.code);assert.equal(preserved.find(s=>s.key==='444').postprocess[1].resourceValues.cardImage.name,'user.png');
 console.log('PASS five category pipelines, seven builtin scripts, category-specific Excel preflight, 444 expand then overlay, saved placeholders repaired, custom code/image preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
