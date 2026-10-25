const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const ctx={window:{},document:{addEventListener(){}},localStorage:{getItem:()=>null}};vm.createContext(ctx);
for(const f of ['category-field-rules.js','excel-row.js','custom-step-defaults.js','custom-step-config.js'])vm.runInContext(fs.readFileSync(f,'utf8'),ctx);
const defaults=ctx.window.CustomStepDefaults,api=ctx.window.CustomStepConfig,ExcelRow=ctx.window.ExcelRow,Rules=ctx.window.CategoryFieldRules;
assert(defaults&&api&&ExcelRow&&Rules,'模块未挂载到 window');
assert.deepEqual(Array.from(defaults,s=>s.key),['111','444','222','333','666']);assert.equal(api.validate(defaults).length,0);
const bad=JSON.parse(JSON.stringify(defaults));bad[1].key='111';assert(api.validate(bad).some(x=>x.includes('重复')));
const unsafe=JSON.parse(JSON.stringify(defaults));unsafe[0].key='../outside';assert(api.validate(unsafe).length);

// 行快照：用本类目真实 Excel 列名（与后处理 ctx.data.cell 同一份数据）
const headers=Array.from(Rules.columnsOf('polo'));
const snapshot=ExcelRow.build({fileName:'A.xlsx',sheetName:'S',rowNumber:7,headers,
    values:headers.map(h=>({材质:'Cotton / 棉',产品特性:'Breathable / 透气',类目:'polo(2)'}[h]??''))});
const step={prompt:'衣服。[[材质：{material}；]][[领型：{collar}；]]要求：{feature}',
    mappings:[{variable:'material',field:'不存在的旧列'}]};
const result=api.preview(step,snapshot);
assert.equal(result.text,'衣服。材质：Cotton；要求：Breathable','真实列名替换 + 空映射段整段省略');
assert.equal(result.missing.length,0);
// 未映射变量如实报出，不静默留下占位符
assert(api.preview({prompt:'{unknown}',mappings:[]},snapshot).missing.includes('unknown'));
// 固定规则要求的真实列整列缺失仍明确报错，不能默默省略可选片段。
const missingMaterial=ExcelRow.build({fileName:'B.xlsx',sheetName:'S',rowNumber:2,headers:['类目'],values:['polo']});
assert.throws(()=>api.preview({prompt:'[[材质：{material}]]',mappings:[]},missingMaterial),/整列不存在/);
assert(api.preview({prompt:'[[未知：{typo}]]',mappings:[]},snapshot).missing.includes('typo'),'可选片段内未知变量也必须报错');
for(const category of Object.keys(Rules.CATEGORY_COLUMNS)){
 const hs=Array.from(Rules.columnsOf(category));
 const values=hs.map(h=>h==='类目'?category:h==='材质'?'Cotton / 棉':h==='面料克重'?0:h==='袖长(cm)'?'65':h==='袖型'?'Regular / 常规袖':h==='袖子款式'?'Short Sleeve / 短袖':'');
 const row=ExcelRow.build({fileName:'C.xlsx',sheetName:'S',rowNumber:3,headers:hs,values});
 const rendered=api.preview({prompt:'{material}|{weight}|{sleeve}',mappings:[]},row);
 assert.equal(rendered.missing.length,0);
 assert.equal(rendered.text,'Cotton|0|'+ExcelRow.englishText(row.role('sleeve').value),'五类目提示词与后处理角色同源，0值保留');
}
// 没有行快照 → 明确报错，不假装渲染成功
assert.throws(()=>api.preview(step,null),/缺少当前产品行快照/);

// 步骤真源：按行类目取面板保存的步骤（执行与预览同一份）
assert.equal(Array.from(api.stepsForCategory('polo')).length,5);
assert.deepEqual(Array.from(api.stepsForCategory('t-shirt'),s=>s.key),['111','444','222','333','666']);
assert.equal(api.uiKeyOf('non-hooded-sweatshirt'),'sweatshirt');
assert.equal(api.canonicalOf('hoodie'),'hooded-sweatshirt');
assert.throws(()=>api.stepsForCategory('jacket'),/未知类目/);

const html=fs.readFileSync('发品助手.html','utf8');assert(html.includes('onclick="CustomStepConfig.open()"'));assert(!html.includes('id="tab-steps"'));assert(!html.includes('id="tab-audit"'));

// 预览语义：预览永远基于【当前草稿】，执行永远基于【任务启动时冻结的已保存配置】
assert(api.PREVIEW_NOTE.includes('预览包含未保存修改')&&api.PREVIEW_NOTE.includes('任务启动时冻结的已保存配置'),'预览提示明确区分「未保存草稿」与「执行用冻结的已保存配置」');
const cfgSrc=fs.readFileSync('custom-step-config.js','utf8');
assert(cfgSrc.includes('step-script-missing')&&cfgSrc.includes('从脚本目录导入'),'面板对「已配置但脚本为空」提示需要导入脚本');
// 占位脚本（空脚本）在预览里必须单列，不混进「无资源声明」
const phStep={name:'细节图',postprocess:[{name:'222细节图后处理.js',path:'js/222细节图后处理.js',code:''}]};
assert(api.postprocessLines(phStep).some(l=>l.includes('222细节图后处理.js')&&l.includes('尚未导入脚本内容')),'预览单列「脚本为空」的占位脚本');
const pv=api.previewText(0,phStep,'行7',{text:'提示词',missing:[]});
assert(pv.includes('预览包含未保存修改')&&pv.includes('222细节图后处理.js'),'预览文案同时包含草稿提示与占位脚本清单');
assert.equal(api.postprocessLines({name:'卖点图',postprocess:[]}).length,0,'无后处理步骤不虚构脚本清单');

// 图片来源：默认111/444用产品主图，222/333/666用AI生成。
assert.deepEqual(Array.from(defaults,s=>s.imageSource),['product','product','generated','generated','generated'],'默认五步自带图片来源');
// 老配置迁移：只补齐缺失的 imageSource，不覆盖用户已有顺序/提示词/映射/脚本/资源。
const legacy={polo:[
 {name:'我的卖点',key:'111',prompt:'用户提示词A',upload:'original',mappings:[{variable:'x',field:'材质'}],postprocess:[{name:'自定义.js',code:'USER_CODE'}],resourceValues:{card:{value:'CARD'}}},
 {name:'我的领口',key:'666',prompt:'用户提示词B',upload:'original',mappings:[]},
 {name:'我的白底',key:'444',prompt:'用户提示词C',upload:'original'}
]};
ctx.localStorage.getItem=()=>JSON.stringify(legacy);
const migrated=Array.from(api.stepsForCategory('polo'));
assert.deepEqual(migrated.map(s=>s.key),['111','666','444'],'迁移保留用户保存的步骤顺序');
assert.deepEqual(migrated.map(s=>s.imageSource),['product','generated','product'],'迁移只补齐来源：111/444=product，其余=generated');
assert.equal(migrated[0].prompt,'用户提示词A');assert.equal(migrated[0].postprocess[0].code,'USER_CODE');
assert.equal(migrated[0].mappings[0].variable,'x');assert.equal(migrated[0].resourceValues.card.value,'CARD');
assert.equal(migrated[1].prompt,'用户提示词B');
// 已显式配置的来源不迁移覆盖
ctx.localStorage.getItem=()=>JSON.stringify({polo:[{name:'x',key:'111',prompt:'p',imageSource:'generated'}]});
assert.equal(Array.from(api.stepsForCategory('polo'))[0].imageSource,'generated','显式来源不被迁移覆盖');
// 来源非法报错；product 不要求提示词，generated 必须有提示词
assert(api.validate([{name:'x',key:'111',prompt:'',imageSource:'ai'}]).some(e=>e.includes('product')||e.includes('generated')));
assert.equal(api.validate([{name:'卖点',key:'111',prompt:'',imageSource:'product'}]).length,0,'产品主图步骤不要求提示词');
assert(api.validate([{name:'袖口',key:'222',prompt:'',imageSource:'generated'}]).some(e=>e.includes('提示词')),'AI 步骤必须有提示词');
ctx.localStorage.getItem=()=>null;
console.log('PASS 新配置入口、参考五步顺序、安全编号校验、重复编号拒绝、行快照真实列名预览、可选片段省略、步骤按类目取（与执行同源）、预览草稿语义与占位脚本提示、图片来源默认值与老配置迁移');

