const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let saved={};const ctx={window:{},document:{addEventListener(){}},localStorage:{getItem:()=>JSON.stringify(saved)}};vm.createContext(ctx);
for(const f of ['category-field-rules.js','excel-row.js','custom-step-defaults.js','custom-step-config.js'])vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const {CustomStepConfig:api,ExcelRow,CategoryFieldRules:rules}=ctx.window;
for(const category of Object.keys(rules.CATEGORY_COLUMNS)){
 const headers=Array.from(rules.columnsOf(category));const row=ExcelRow.build({fileName:category+'.xlsx',sheetName:'S',rowNumber:4,headers,values:headers.map(h=>h==='类目'?category:h==='材质'?'Cotton / 棉':h==='面料克重'?'300 / 300克':h===rules.columnOf('weave',category)?'Knitted / 针织':'')});
 const step={key:'222',name:'test',prompt:'{material}|{weave}',postprocess:[],mappings:[{variable:'material',label:'material',field:'面料克重',custom:true},{variable:'weave',label:'weave',field:'材质',custom:true}]};
 assert.equal(api.renderPrompt(step,row).text,'300|Cotton');
 saved[api.uiKeyOf(category)]=[step];const frozen=api.stepsForCategory(category);step.mappings[1].field='面料克重';assert.equal(api.renderPrompt(frozen[0],row).text,'300|Cotton','task config clone retains selected field');
 const reset={...frozen[0],mappings:[]};assert.equal(api.renderPrompt(reset,row).text,'Cotton|Knitted');
}
console.log('PASS default variable overrides for five categories, saved config execution, task config clone, restore category defaults');
