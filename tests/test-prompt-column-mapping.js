const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const env={window:{},document:{addEventListener(){}},localStorage:{getItem:()=>null}};vm.createContext(env);
for(const file of ['category-field-rules.js','excel-row.js','custom-step-defaults.js','custom-step-config.js'])vm.runInContext(fs.readFileSync(file,'utf8'),env);
const {CustomStepConfig:api,ExcelRow,CategoryFieldRules:rules}=env.window;
for(const category of Object.keys(rules.CATEGORY_COLUMNS)){
 const headers=Array.from(rules.columnsOf(category));
 const row=ExcelRow.build({fileName:category+'.xlsx',sheetName:'S',rowNumber:7,headers,values:headers.map(h=>h==='类目'?category:h==='材质'?'Cotton / 棉':h==='面料克重'?0:'')});
 const step={name:'test',key:'444',prompt:'Use {map_1}; {map_2}. [[Extra: {map_3}]]',mappings:[{variable:'map_1',label:'背景的',field:'材质',custom:true},{variable:'map_2',label:'克重',field:'面料克重',custom:true},{variable:'map_3',label:'工艺',field:'工艺',custom:true}]};
 const result=api.renderPrompt(step,row);assert.equal(result.text,'Use Cotton; 0. ');assert.equal(result.missing.length,0);
 assert.equal(api.validate([step]).length,0);
 const restored=JSON.parse(JSON.stringify(step));assert.equal(api.renderPrompt(restored,row).text,result.text);
 restored.mappings[0].field='';assert(api.renderPrompt(restored,row).missing.includes('map_1'));assert(api.validate([restored]).some(e=>e.includes('背景的')));
 restored.mappings[0].field='袖长(cm)';if(category!=='shirt')assert.throws(()=>api.renderPrompt(restored,row),/当前类目没有映射列/);
 const html=api.promptMarkup(step);assert(html.includes('data-map-token="map_1"'));assert(html.includes('{背景的}'));assert(html.includes('contenteditable="false"'));
}
const minimal=ExcelRow.build({fileName:'missing.xlsx',sheetName:'S',rowNumber:2,headers:['类目'],values:['polo']});
assert.throws(()=>api.renderPrompt({prompt:'{map_1}',mappings:[{variable:'map_1',label:'材质',field:'材质',custom:true}]},minimal),/整列不存在/);
const chinese=ExcelRow.build({fileName:'cn.xlsx',sheetName:'S',rowNumber:2,headers:['类目','材质'],values:['polo','纯棉']});
assert.throws(()=>api.renderPrompt({prompt:'{map_1}',mappings:[{variable:'map_1',field:'材质',custom:true}]},chinese),/英文/);
const escaped=api.promptMarkup({prompt:'<img onerror=x>{map_1}',mappings:[{variable:'map_1',label:'<script>bad</script>',custom:true}]});assert(!escaped.includes('<img'));assert(!escaped.includes('<script>'));
console.log('PASS five category custom Excel mapping, English-only/zero/empty/missing column handling, persistence, unmapped validation, highlighted tokens and HTML escaping');
