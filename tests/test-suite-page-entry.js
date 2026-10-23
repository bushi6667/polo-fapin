// Executes the production page entry points, task state machine and core pipeline.
// Only browser/network/storage edges are replaced. No real image requests are sent.
//
// 2026-10-23 功能状态说明（必须如实反映，不得为通过测试而改边界）：
//   套图入口已接通为「一键合并生成」：startSuiteGeneration() / startSuiteRegenerate(key)
//   一键整套 → 用 batch-gen 模式创建【一次】合并任务（expectCount=3、targetKeys=['222','333','666']）→
//   发出【一次】suiteRun 请求 → 三张 AI 原图一次取回 → 独立终态 generated（不代表成品已保存）→
//   111/444 直接用产品主图后处理（无 AI 请求）；五张成品齐全才判定套图完成并显示角标。
//   指定重生成（targeted）保持逐步：222/333/666 各自发一次请求。
//   因此本测试：(J) 断言一键整套的合并语义（一次请求、仅 AI 步骤、落盘进 <文件名>/rowN 子目录）；
//     (B)~(I) 验证仍在使用的确认/冻结/写盘/索引/恢复路径不被新流程破坏。
//   切片右边界原为已删除的 `function renderSuiteSteps`，会让切片一直延伸到文件末尾并吞进
//   `</script>` 造成语法错误；现改为现存函数 `function escapeHtml`（紧邻套图段落之后的稳定边界）。
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, '发品助手.html'), 'utf8');
const section = html.slice(html.indexOf('const SUITE_OUTPUTS'), html.indexOf('function escapeHtml'));
assert(html.indexOf('const SUITE_OUTPUTS') > 0 && html.indexOf('function escapeHtml') > html.indexOf('const SUITE_OUTPUTS'), 'suite section boundaries must exist');
// 入口与确认/完成/渲染/待确认展示等仍在用，必须一起被切进来
for (const fn of ['async function startSuiteGeneration', 'async function startSuiteRegenerate', 'async function confirmSuiteNumbering', 'async function finishSuiteTask', 'async function renderSuiteImages', 'function renderSuitePendingNumbering']) {
    assert(section.includes(fn), 'suite section must contain ' + fn);
}
for (const f of ['suite-core.js','suite-postprocess.js','suite-image-transform.js','suite-image-sdk.js']) assert(html.includes('<script src="chrome_extension/suite/'+f+'"></script>'), 'page must actually load '+f);
const records = new Map(), tasksStorage = {}, files = new Map(), messages = [], statuses = [];
// 套图成品现在全部进 <文件名>/rowN 子目录（与颜色图同构），根层 files 只留给非套图数据。
// 写盘总数 = 根层 + 所有子目录文件数之和。
const totalFiles = () => files.size + [...dir.subdirs.values()].reduce((s, m) => s + (m && m.size || 0), 0);
const objectBlobs = new Map(), fetchedUrls = [];
let failWrite = false;
// 故障注入：failStorePut='rowfreeze' 让「冻结记录」写入失败；forcePostFail 让后处理整体失败。
let failStorePut = null, forcePostFail = false;
// 每次进入后处理时，记录当时是否已存在冻结记录 → 证明「冻结先落盘，后处理后执行」
const freezeAtPostTime = [];
const nodes = new Map();
const node = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '', value: '0', firstElementChild:{ textContent:'' }, append:function(){}, setAttribute:function(){} }); return nodes.get(id); };
const keys = ['111','222','333','444','666'];
const steps = keys.map(key => ({ name: key, outputKeys: [{ key }], model:'5.0', ratio:'1:1', prompt:'generate ' + key, uploads:[{type:'current_file',filenames:['样式图']}], postprocess:{type:'none'} }));
const dir = {
    permission:'granted', queryPermission:async () => dir.permission,
    // 子目录模拟：每个子目录也是完整 handle（含 getDirectoryHandle/getFileHandle），
    // 用 dir.subdirs[相对路径] 记录各子目录内的文件（与扩展 fs 逐级建目录行为一致）。
    subdirs: new Map(), // key: 相对路径（'<fileName>/rowN'） → Map<filename, Blob>
    rootFiles: files,
    _mkHandle(fileMap, name) {
        return {
            name, permission:'granted',
            queryPermission:async () => 'granted',
            subdirs: dir.subdirs,
            files: fileMap,
            getDirectoryHandle: async (child, opts) => {
                const key = String(name).replace(/\/$/, '') + '/' + child;
                if (!dir.subdirs.has(key) && opts?.create) dir.subdirs.set(key, new Map());
                if (!dir.subdirs.has(key)) throw Object.assign(new Error('missing dir'), { name:'NotFoundError' });
                return dir._mkHandle(dir.subdirs.get(key), key);
            },
            getFileHandle: async (fn, opts) => {
                const m = fileMap;
                if (failWrite && opts?.create && /(^|[^0-9])444(\.png|_)/.test(fn)) throw new Error('simulated disk failure');
                if (!m.has(fn) && !opts?.create) throw Object.assign(new Error('missing'), { name:'NotFoundError' });
                return { createWritable:async () => ({ write:async b => m.set(fn,b), close:async () => {} }), getFile:async () => m.get(fn) };
            }
        };
    },
    getDirectoryHandle: async (child, opts) => {
        const key = String(child).replace(/\/$/, '');
        if (!dir.subdirs.has(key) && opts?.create) dir.subdirs.set(key, new Map());
        if (!dir.subdirs.has(key)) throw Object.assign(new Error('missing dir'), { name:'NotFoundError' });
        return dir._mkHandle(dir.subdirs.get(key), key);
    },
    getFileHandle: async (name, opts) => {
        if (failWrite && opts?.create && /(^|[^0-9])444(\.png|_)/.test(name)) throw new Error('simulated disk failure');
        if (!files.has(name) && !opts?.create) throw Object.assign(new Error('missing'), { name:'NotFoundError' });
        return { createWritable:async () => ({ write:async b => files.set(name,b), close:async () => {} }), getFile:async () => files.get(name) };
    }
};
// 浏览器边界替身：页面用 FileReader 把结果图片转 base64 交给扩展写盘（真实浏览器自带）。
class FileReaderPolyfill {
    constructor() { this.result = null; this.onload = null; this.onerror = null; }
    readAsDataURL(blob) {
        blob.arrayBuffer().then(bytes => {
            this.result = 'data:' + (blob.type || 'image/png') + ';base64,' + Buffer.from(bytes).toString('base64');
            if (this.onload) this.onload();
        }, err => { if (this.onerror) this.onerror(err); });
    }
}
const browser = {
    console, Blob, Uint8Array, structuredClone, setTimeout, clearTimeout, FileReader: FileReaderPolyfill,
    crypto:require('crypto').webcrypto,
    products:[{row:2},{row:7}], currentProduct:{row:7}, extensionInstalled:true, loadedFileName:'test.xlsx', EXTENSION_ID:'test',
    document:{
        getElementById:node,
        querySelector:() => null,
        createElement:() => { let pixel; const el={ style:{cssText:''}, textContent:'', innerHTML:'', append:function(){}, setAttribute:function(){}, firstElementChild:{textContent:''}, onclick:null, children:[] }; el.getContext=() => ({drawImage:b => pixel=b.id}); el.toDataURL=() => 'fp:' + pixel; return el; },
        body:{ append:function(){} }
    },
    URL:{createObjectURL:b => { const u='blob:preview/'+objectBlobs.size;objectBlobs.set(u,b);return u; },revokeObjectURL:() => {}},
    createImageBitmap:async b => ({width:128,height:128,id:await b.text(),close(){}}),
    fetch:async url => { fetchedUrls.push(url); return {ok:true,blob:async () => objectBlobs.get(url) || new Blob([String(url)],{type:'image/png'})}; },
    showToast:m => statuses.push(m),
    chrome:{runtime:{ lastError:null, sendMessage:(id, req, cb) => {
        messages.push(req);
        (async () => {
            if(req.action==='suiteOutputStatus')return {ok:true,configured:true,permission:'granted'};
            if(req.action==='suiteCancel'){await browser.SuiteTaskStore.cancel(req.taskId);return {ok:true};}
            if(req.action==='suiteCreate')return {ok:true,task:await browser.SuiteTaskStore.create(req.task)};
            if(req.action==='suiteGetTask')return {ok:true,task:await browser.SuiteTaskStore.get(req.taskId)};
            if(req.action==='suiteListTasks')return {ok:true,tasks:await browser.SuiteTaskStore.list(req)};
            if(req.action==='suiteRun'){
                if(browser.pauseOnGenerate){browser.pauseOnGenerate=false;browser.toggleSuiteAuto();}
                await browser.SuiteTaskStore.advance(req.taskId,'sent');
                const pending=await browser.SuiteTaskStore.get(req.taskId);
                const images=Array.from({length:pending.expectCount},(_,i)=>'https://image/'+req.taskId+'/'+i);
                await browser.SuiteTaskStore.advance(req.taskId,'acquired',{images});
                return {ok:true,images};
            }
            if(req.action==='suiteProgress'){
                const check=await browser.SuiteTaskStore.acceptReport(req.report);
                if(!check.accepted)return {ok:false,error:check.reason};
                const r=req.report;
                return {ok:true,task:r.final ? await browser.SuiteTaskStore.finish(r.taskId,r.finalStage,r.error,{results:r.results||[],diag:r.diag||[]}) : await browser.SuiteTaskStore.advance(r.taskId,r.stage)};
            }
            // 套图输出目录桥：生产实现里句柄只在扩展源，写盘/回读由扩展完成（见 background.js suiteWriteOutput/suiteVerifyOutput）。
            // 本测试只替换「消息」这一边界，写盘/回读仍走真实 SuiteCore.saveAll / verifySavedFiles。
            if(req.action==='suiteWriteOutput'){
                const items=(req.files||[]).map(f=>({key:f.key, filename:f.filename,
                    blob:new Blob([Buffer.from(String(f.dataUrl).split(',')[1],'base64')],{type:'image/png'})}));
                // 与扩展行为一致：subdir 为相对路径（<fileName>/rowN），落到对应子目录，不进根层。
                const target = req.subdir
                    ? (async () => {
                          const parts = String(req.subdir).split('/');
                          let h = dir;
                          for (const p of parts) h = await h.getDirectoryHandle(p, { create: true });
                          return h;
                      })()
                    : Promise.resolve(dir);
                const targetDir = await target;
                const saved = await browser.SuiteCore.saveAll(targetDir, items, {
                    buildFilename:it=>it.filename,
                    decodeSize:async b=>browser.createImageBitmap(b),
                    hash:async b=>{const d=await browser.crypto.subtle.digest('SHA-256', await b.arrayBuffer()); return Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('');}
                });
                return {ok:saved.ok, results:saved.results, savedCount:saved.savedCount, failedKeys:saved.failedKeys, retrySaveOnly:saved.retrySaveOnly, mode:'fs', dirName:req.subdir||''};
            }
            if(req.action==='suiteVerifyOutput'){
                const recs=(req.records||[]).map(r=>({key:r.key, meta:{filename:r.filename, bytes:r.bytes, contentHash:r.contentHash}}));
                const target = req.subdir
                    ? (async () => {
                          const parts = String(req.subdir).split('/');
                          let h = dir;
                          for (const p of parts) h = await h.getDirectoryHandle(p, { create: false });
                          return h;
                      })()
                    : Promise.resolve(dir);
                const targetDir = await target;
                const v=await browser.SuiteCore.verifySavedFiles(recs, { dirHandle:targetDir,
                    decodeSize:async()=>({width:128,height:128}),
                    hash:async b=>{const d=await browser.crypto.subtle.digest('SHA-256', await b.arrayBuffer()); return Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('');} });
                return {ok:v.ok, items:v.items, unverified:v.unverified};
            }
            throw new Error('Unexpected action '+req.action);
        })().then(cb,e=>cb({ok:false,error:e.message}));
    }},storage:{local:{get:(key,cb)=>cb({[key]:tasksStorage[key]}),set:(o,cb)=>{Object.assign(tasksStorage,structuredClone(o));cb();}}}}
};
browser.globalThis=browser;
browser.window=browser;
// 面板配置的唯一真源：polo 类目已保存配置，其中 111 步骤挂了一个读取当前产品行的脚本。
// 脚本同时回读输入图（input）—— 用于验证「确认的编号映射」确实决定了这一步取的是哪张候选图。
const PANEL_SCRIPT = "CustomJsSDK.run(async ({ data, input }) => new Blob([data.cell('材质') + '|' + await input.text()], { type: 'image/png' }));";
const PANEL_STEPS = ['111','222','333','444','666'].map(key => ({
    name: key, key, prompt: '生成 ' + key, upload: 'original',
    postprocess: key === '111' ? [{ name: '读行数据.js', path: '读行数据.js', code: PANEL_SCRIPT }] : [],
    mappings: [],
}));
browser.localStorage={getItem:k=>k==='polo_custom_step_editor_v1'?JSON.stringify({polo:PANEL_STEPS}):null,setItem:()=>{}};
browser.document.addEventListener=()=>{};
const ctx=vm.createContext(browser);
for(const f of ['suite-core.js','suite-postprocess.js','suite-task.js','suite-image-transform.js','suite-image-sdk.js']) vm.runInContext(fs.readFileSync(path.join(root,'chrome_extension/suite',f),'utf8'),ctx);
for(const f of ['script-contract-parser.js','category-field-rules.js','excel-row.js','custom-js-data.js','custom-step-defaults.js','custom-step-config.js']) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);
// 当前导入 Excel（真实业务实现）：表头用 polo 真实列名，第 7 行是任务绑定的产品行
vm.runInContext('let currentSheet = null;\n' + html.slice(html.indexOf('function sheetRangeStartRow('), html.indexOf('// 读取 Excel 文件')), ctx, { filename:'发品助手.html:sheet' });
const POLO_HEADERS=Array.from(browser.CategoryFieldRules.columnsOf('polo'));
const poloRowValues=over=>({ 材质:'Cotton / 棉', 面料克重:180, 类目:'polo(2)', ...(over||{}) });
vm.runInContext('currentSheet = __sheet;', Object.assign(ctx,{__sheet:{ fileName:'test.xlsx', sheetName:'S1', startRow:1, headers:POLO_HEADERS, rows:[POLO_HEADERS, POLO_HEADERS.map(h=>poloRowValues({材质:'Silk / 丝'})[h] ?? '')].concat(Array.from({length:5},()=>POLO_HEADERS.map(h=>poloRowValues()[h] ?? ''))) }}));
let postRuns=0;const postCtx=[];const actualPost=browser.SuitePostprocess.runAll;
browser.SuitePostprocess.runAll=async(...args)=>{
    postRuns++;postCtx.push(args[3]);
    if(browser.pauseOnPost){browser.pauseOnPost=false;await browser.toggleSuiteAuto();}
    // 进入后处理的那一刻，冻结记录是否已落盘（证明「冻结先落盘，后处理才执行」）
    freezeAtPostTime.push([...records.keys()].some(k=>k.endsWith('|rowfreeze')));
    if(forcePostFail)return{ok:false,failedKeys:['111'],results:[{ok:false,key:'111',error:'注入的后处理失败'}],retryProcessOnly:true};
    return actualPost(...args);
};
const coreStore=browser.SuiteCore.ResultStore;
browser.SuiteCore.ResultStore=(db='results')=>({
    put:async r=>{if(failStorePut&&r.key===failStorePut)throw new Error('simulated freeze save failure');records.set(db+'|'+r.fileKey+'|'+r.rowNum+'|'+r.key,structuredClone(r));return r;},
    putMany:async rows=>{for(const r of rows)records.set(db+'|'+r.fileKey+'|'+r.rowNum+'|'+r.key,structuredClone(r));},
    get:async (fk,row,key)=>records.get(db+'|'+fk+'|'+row+'|'+key)||null,
    list:async (fk,row)=>[...records.entries()].filter(([k,r])=>k.startsWith(db+'|')&&r.fileKey===fk&&r.rowNum===row).map(([,r])=>r),
    remove:async (fk,row,key)=>records.delete(db+'|'+fk+'|'+row+'|'+key)
});
// 预览状态文字使用页面同一个 HTML 转义函数，沙箱也加载真实实现。
vm.runInContext(html.slice(html.indexOf('function escapeHtml(s)'),html.indexOf('const AUDIT_DATA')),ctx);
vm.runInContext(section,ctx);
vm.runInContext(`
 currentFileKey=()=> 'test.xlsx';
 loadedFileName='test.xlsx';
 updateSuiteStatus=m=>showToast(m);
 // 角标渲染函数在切片之外；这里替换为记录调用，用于断言「五张成品齐全才显示套图」。
 addSuiteGeneratedBadge=r=>{suiteBadgeRows.push(r);};
 resolveSuiteAssets=async p=>({assets:{main:{url:'main',color:'main',row:p.row,fileKey:'test.xlsx'}},problems:[],fileKey:'test.xlsx'});
 prepareSuiteAssets=async a=>Object.values(a);
 loadSuiteDirHandle=async()=>testDir;
 getSuiteDirHandles=()=>({});
`,Object.assign(ctx,{testDir:dir,suiteBadgeRows:[]}));

// 注入「待确认编号」状态：与停用入口原先产出的一致（taskId/fileKey/rowNum/steps/候选顺序）
function seedPending(taskId, rowNum = 7, fileKey = 'test.xlsx') {
    const images = keys.map((_, i) => 'https://image/' + taskId + '/' + i);
    const pending = { taskId, fileKey, rowNum, steps, candidates: browser.SuiteCore.buildNumberingCandidates(images, keys.map(k => ({ key: k }))) };
    vm.runInContext('suitePendingNumbering = ' + JSON.stringify(pending) + ';', ctx);
    return pending;
}

(async()=>{
    /* ---------- (A) 生成入口：已接通单步骤真实执行（single-regen，一次请求一张） ---------- */
    await browser.runSuiteJob(['111','444','222','333','666']);
    const createsA = messages.filter(m => m.action === 'suiteCreate');
    const runsA = messages.filter(m => m.action === 'suiteRun');
    assert.strictEqual(createsA.length, 1, '接通后的生成入口必须创建 1 个任务');
    assert.strictEqual(runsA.length, 1, '接通后的生成入口只发出一次生成请求（绝不逐张多次）');
    assert.strictEqual(createsA[0].task.mode, 'quick-five', '整套入口创建一次五图任务');
    assert.strictEqual(createsA[0].task.expectCount, 5, '整套任务必须要求5张');
    assert.strictEqual(JSON.stringify(createsA[0].task.targetKeys), JSON.stringify(['111','444','222','333','666']), '五个编号保持配置顺序');
    assert.strictEqual(createsA[0].task.fileKey, 'test.xlsx', '任务绑定当前文件标识');
    assert.strictEqual(createsA[0].task.rowNum, 7, '任务绑定当前产品行');
    assert(createsA[0].task.prompt && createsA[0].task.prompt.includes('222'), '任务带的是该步骤真实渲染后的提示词正文');
    assert(createsA[0].task.assets && createsA[0].task.assets.length === 1 && !!createsA[0].task.assets[0].url, '任务素材来自当前产品原图真实预检结果');
    // 入口只负责「获取结果 + 产出待确认编号」，不越权执行后处理 / 写盘 / 自动确认
    assert(vm.runInContext('!!suitePendingNumbering', ctx), '入口产出待确认编号状态，等待用户确认');
    assert.strictEqual(JSON.stringify(vm.runInContext('suitePendingNumbering.candidates.map(c=>c.key)', ctx)), JSON.stringify(['111','444','222','333','666']), '5张结果全部进入待确认');
    assert.strictEqual(vm.runInContext('suitePendingNumbering.rowNum', ctx), 7, '待确认编号绑定同一产品行');
    assert(node('suiteImagesGrid').innerHTML.includes('未确认'), '待确认候选已渲染（未自动执行后处理）');
    assert.strictEqual(postRuns, 0, '入口自身不执行后处理（编号确认后才执行）');
    assert.strictEqual(files.size, 0, '入口自身不写盘');
    assert.strictEqual((await browser.SuiteCore.ResultStore().list('test.xlsx', 7)).length, 0, '入口不改动结果索引（只落待确认记录）');
    // 结束该任务并清空待确认状态，避免与后续同类任务冲突
    await browser.SuiteTaskStore.cancel(vm.runInContext('suitePendingNumbering.taskId', ctx));
    vm.runInContext('suitePendingNumbering=null', ctx);

    /* ---------- (B) 仍在用的链路：确认 → 后处理 → 写盘 → 索引 ---------- */
    const task = await browser.SuiteTaskStore.create({ fileKey:'test.xlsx', rowNum:7, productId:7, mode:'quick-five', targetKeys:keys, expectCount:5, prompt:'五张快速生成' });
    await browser.SuiteTaskStore.advance(task.taskId,'sent');
    await browser.SuiteTaskStore.advance(task.taskId,'acquired');
    // 经真实页面路径登记任务身份（本节直接用测试造出 quick-five 任务，非入口产生）
    await vm.runInContext("suiteSend('suiteListTasks',{fileKey:'test.xlsx',rowNum:7})",ctx);
    seedPending(task.taskId);
    assert(vm.runInContext('!!suitePendingNumbering',ctx),'pending state must be reachable by the live confirm entry');

    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    failWrite=true;
    await browser.confirmSuiteNumbering();
    assert.strictEqual((await browser.SuiteTaskStore.get(task.taskId)).stage,'acquired','failed save cannot complete');
    assert.strictEqual((await browser.SuiteCore.ResultStore().list('test.xlsx',7)).length,0,'partial save does not replace indexes');
    const processed=postRuns;failWrite=false;
    assert(processed>=1,'confirmation must actually run postprocessing');

    // 页面状态丢失后从持久化恢复待确认编号（恢复不得重新发豆包）
    const runsBeforeRestore=messages.filter(m=>m.action==='suiteRun').length;
    vm.runInContext('suitePendingNumbering=null',ctx);
    await browser.SuiteTaskStore.recoverOnStartup();
    await browser.renderSuiteImages(browser.currentProduct);
    assert(vm.runInContext('!!suitePendingNumbering',ctx),'pending candidates restored after page state loss');
    assert(!!vm.runInContext('suitePendingNumbering.excelRowSpec',ctx),'冻结的行数据规格随待确认记录持久化，页面状态丢失后仍可用');
    assert(node('suiteImagesGrid').innerHTML.includes('未确认'),'restore renders the pending candidates, not an empty grid');
    assert.strictEqual(messages.filter(m=>m.action==='suiteRun').length,runsBeforeRestore,'restore never resends');

    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    const runsBeforeConfirm=messages.filter(m=>m.action==='suiteRun').length;
    await browser.confirmSuiteNumbering();
    assert.strictEqual(postRuns,processed,'retry save does not repeat postprocessing');
    assert.strictEqual(messages.filter(m=>m.action==='suiteRun').length,runsBeforeConfirm,'confirm/save path never generates');
    const t=await browser.SuiteTaskStore.get(task.taskId);
    assert.strictEqual(t.stage,'completed',statuses.join('\n'));
    // 确认链路的五张成品现在落进 <文件名>/rowN 子目录（与颜色图同构），不进根层
    const suiteDirB = dir.subdirs.get('test.xlsx/row7');
    assert(suiteDirB && suiteDirB.size === 5, '确认链路五张成品落在 Polo发品_颜色图/test.xlsx/row7/ 子目录');
    assert.strictEqual(files.size, 0, '确认链路套图成品不进根层');
    const saved=await browser.SuiteCore.ResultStore().list('test.xlsx',7);
    assert.strictEqual(saved.length,5);
    // 111 步骤挂了面板里的后处理脚本：落盘内容 = 冻结行的「材质」列 + 它实际拿到的输入图。
    // 前者证明提示词与后处理读的是同一份任务冻结行数据；后者证明确认的编号映射（111→候选下标 4）真的生效。
    assert.strictEqual(await saved.find(r=>r.key==='111').blob.text(),'Cotton|https://image/'+task.taskId+'/4','confirmed mapping used + 后处理读取任务冻结行');
    assert(fetchedUrls.some(u=>u.endsWith('/4')),'confirmed candidate image actually fetched');
    assert(messages.filter(m=>m.action==='suiteProgress').every(m=>m.report.fileKey==='test.xlsx'&&m.report.rowNum===7),'progress identity included');

    /* ---------- (C) 渲染：磁盘核验 / 缺失 / 无权限（真实路径，非字符串匹配） ---------- */
    await browser.renderSuiteImages(browser.currentProduct);
    assert(!node('suiteImagesGrid').innerHTML.includes('suite-image-status'),'cards omit internal disk diagnostics');
    for(const k of keys)assert(node('suiteImagesGrid').innerHTML.includes('<span>'+k+'</span>'),'all five still rendered');
    const suiteDirC = dir.subdirs.get('test.xlsx/row7');
    const firstSuiteFile = saved[0].meta.filename;
    if (suiteDirC && suiteDirC.has(firstSuiteFile)) suiteDirC.delete(firstSuiteFile);
    await browser.renderSuiteImages(browser.currentProduct);
    assert(node('suiteImagesGrid').innerHTML.includes('<img ')&&!node('suiteImagesGrid').innerHTML.includes('suite-image-status'),'generated images remain visible without disk diagnostics');
    dir.permission='denied';await browser.renderSuiteImages(browser.currentProduct);
    assert(node('suiteImagesGrid').innerHTML.includes('<img ')&&!node('suiteImagesGrid').innerHTML.includes('no-permission'),'disk permission does not replace generated preview');
    dir.permission='granted';

    /* ---------- (D) 单张重生成入口：走同一五步链路，只对指定编号发一次生成请求 ---------- */
    const filesBeforeD = files.size;
    const createsBeforeD = messages.filter(m=>m.action==='suiteCreate').length;
    const runsBeforeD = messages.filter(m=>m.action==='suiteRun').length;
    await browser.startSuiteRegenerate('222');
    const lastCreateD = messages.filter(m=>m.action==='suiteCreate').slice(-1)[0];
    assert.strictEqual(messages.filter(m=>m.action==='suiteCreate').length, createsBeforeD+1, '单张重生成入口创建一个新任务');
    assert.strictEqual(messages.filter(m=>m.action==='suiteRun').length, runsBeforeD+1, '单张重生成入口只发一次请求');
    assert.strictEqual(JSON.stringify(lastCreateD.task.targetKeys), JSON.stringify(['222']), '单张重生成指定编号为 222');
    assert.strictEqual(lastCreateD.task.expectCount, 1, '单张重生成 expectCount 为 1');
    assert.strictEqual(files.size, filesBeforeD, '套图成品全部进子目录，根层文件数不变：'+statuses.slice(-3).join(' | '));
    const suiteDirD = dir.subdirs.get('test.xlsx/row7');
    assert(suiteDirD && [...suiteDirD.keys()].some(n=>n==='222.png'||n.includes('_222_')), '单张重生成 222 覆盖子目录内的 222 成品（不再进根层）');
    const idxD = await browser.SuiteCore.ResultStore().list('test.xlsx',7);
    assert.strictEqual(idxD.length, 5, '结果索引仍是 5 个编号（222 被本步替换，不新增编号）');
    assert(idxD.find(r=>r.key==='222').meta.verified===true, '222 成品已写盘并校验');
    assert.strictEqual(records.has('polo_suite_pending|test.xlsx|7|fivefreeze'), false, '单步成功后清理冻结记录（已完成步骤不再重跑）');
    // 收尾：结束该任务，避免影响后续场景
    await browser.SuiteTaskStore.cancel(messages.filter(m=>m.action==='suiteRun').slice(-1)[0].taskId);
    vm.runInContext('suitePendingNumbering=null',ctx);

    /* ---------- (E) 取消/终态守卫：确认不得写盘，完成不得绕过 saved ---------- */
    const cancelTask=await browser.SuiteTaskStore.create({fileKey:'test.xlsx',rowNum:7,mode:'quick-five',targetKeys:keys,expectCount:5});
    await browser.SuiteTaskStore.advance(cancelTask.taskId,'sent');
    await browser.SuiteTaskStore.advance(cancelTask.taskId,'acquired');
    seedPending(cancelTask.taskId);
    await browser.SuiteTaskStore.cancel(cancelTask.taskId);
    const filesBeforeCancel=totalFiles();
    await browser.confirmSuiteNumbering();
    assert.strictEqual(totalFiles(),filesBeforeCancel,'cancelled confirmation has no disk writes');
    const state=await browser.SuiteTaskStore.create({fileKey:'x',rowNum:1,mode:'single-regen',targetKeys:['111'],expectCount:1});
    await assert.rejects(()=>browser.SuiteTaskStore.finish(state.taskId,'completed'),'cannot bypass saved');

    /* ---------- (F) 任务数据冻结：切换产品 / 重导 Excel 不改变已开始任务绑定的行 ---------- */
    // 第 2 行是「丝」，第 7 行是「棉」——冻结必须取任务绑定的那一行，而不是界面当前行。
    const pendingFreeze = { taskId:'freeze-1', fileKey:'test.xlsx', rowNum:2, steps, candidates:[] };
    const frozenOnce = await browser.freezeSuiteTaskData(pendingFreeze, 'test.xlsx', 2);
    assert.strictEqual(frozenOnce.snapshot.cell('材质'),'Silk / 丝','冻结的是任务绑定的第 2 行（不是界面当前行第 7 行）');
    assert.strictEqual(frozenOnce.snapshot.sheetName,'S1','冻结记录了实际工作表名');
    assert(!!pendingFreeze.excelRowSpec,'冻结规格已写回待确认状态，刷新后可复用');
    // 模拟重新导入 Excel：整份工作表被替换（同名、内容已变），当前产品也切到别的行
    vm.runInContext(`currentSheet = { fileName: 'test.xlsx', sheetName: 'S2', startRow: 1, headers: currentSheet.headers,
        rows: currentSheet.rows.map((row, i) => i === 1 ? currentSheet.headers.map(h => ({ '类目': 'polo(2)', '材质': '重导后' }[h] ?? '')) : row) };`, ctx);
    browser.currentProduct = { row: 2 };
    const frozenAgain = await browser.freezeSuiteTaskData(pendingFreeze, 'test.xlsx', 2);
    assert.strictEqual(frozenAgain.snapshot.cell('材质'),'Silk / 丝','重导 Excel 后，已开始任务仍用启动时冻结的行数据');
    assert.strictEqual(frozenAgain.snapshot.sheetName,'S1','冻结的工作表名也不随后续重导改变');
    const promptStep = { prompt:'材质：{material}', mappings:[{ variable:'material', field:'材质' }] };
    assert.strictEqual(browser.suiteRenderPrompt(promptStep, frozenAgain.snapshot).text,'材质：Silk','提示词渲染读的是任务冻结行（与后处理同一份快照）');
    // 未冻结且任务文件与当前导入 Excel 不符 → 明确拒绝，绝不读成另一份 Excel 的行
    await assert.rejects(()=>browser.freezeSuiteTaskData({taskId:'freeze-2',fileKey:'other.xlsx',rowNum:2,steps,candidates:[]},'other.xlsx',2),/与任务不符/,'任务文件不符时必须拒绝读取当前 Excel 的行');
    browser.currentProduct = { row: 7 };

    /* ---------- (G) 冻结必须先落盘再执行后处理；落盘失败即停止执行 ---------- */
    // 成功路径的顺序性：每次进入后处理时，冻结记录都已存在（否则刷新后无从恢复）
    assert(freezeAtPostTime.length >= 1 && freezeAtPostTime.every(Boolean), '进入后处理前，冻结记录必须已落盘（冻结先于后处理）');
    const taskG = await browser.SuiteTaskStore.create({fileKey:'test.xlsx',rowNum:7,mode:'quick-five',targetKeys:keys,expectCount:5});
    await browser.SuiteTaskStore.advance(taskG.taskId,'sent');
    await browser.SuiteTaskStore.advance(taskG.taskId,'acquired');
    await vm.runInContext("suiteSend('suiteListTasks',{fileKey:'test.xlsx',rowNum:7})",ctx);
    seedPending(taskG.taskId);
    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    const postBeforeG=postRuns, filesBeforeG=totalFiles();
    failStorePut='rowfreeze';
    await browser.confirmSuiteNumbering();
    failStorePut=null;
    assert(statuses[statuses.length-1].includes('任务冻结数据保存失败'),'冻结保存失败必须明确报错（'+statuses[statuses.length-1]+'）');
    assert.strictEqual(postRuns,postBeforeG,'冻结保存失败时不得执行后处理');
    assert.strictEqual(totalFiles(),filesBeforeG,'冻结保存失败时不得写盘');
    assert.strictEqual(records.has('polo_suite_pending|test.xlsx|7|rowfreeze'),false,'冻结记录确实未落盘');
    assert.strictEqual((await browser.SuiteTaskStore.get(taskG.taskId)).stage,'acquired','冻结保存失败时任务保持可重试阶段');
    // 冻结保存失败后无 pending 记录残留；结束该任务以便后续场景复用同一产品行
    assert.strictEqual(records.has('polo_suite_pending|test.xlsx|7|pending'),false,'冻结保存失败时不落待确认记录');
    await browser.SuiteTaskStore.cancel(taskG.taskId);

    /* ---------- (H) 后处理失败 → 冻结保留 → 刷新 → 同名重导 Excel → 恢复仍用原冻结数据 ---------- */
    const taskH = await browser.SuiteTaskStore.create({fileKey:'test.xlsx',rowNum:7,mode:'quick-five',targetKeys:keys,expectCount:5});
    await browser.SuiteTaskStore.advance(taskH.taskId,'sent');
    await browser.SuiteTaskStore.advance(taskH.taskId,'acquired');
    await vm.runInContext("suiteSend('suiteListTasks',{fileKey:'test.xlsx',rowNum:7})",ctx);
    seedPending(taskH.taskId);
    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    const postBeforeH=postRuns, filesBeforeH=totalFiles();
    forcePostFail=true;
    await browser.confirmSuiteNumbering();
    forcePostFail=false;
    assert(postRuns>postBeforeH,'后处理确实执行了（随后失败）');
    assert(statuses[statuses.length-1].includes('后处理失败'),'后处理失败被如实报告（'+statuses[statuses.length-1]+'）');
    assert.strictEqual(totalFiles(),filesBeforeH,'后处理失败不写盘');
    assert.strictEqual(records.has('polo_suite_pending|test.xlsx|7|rowfreeze'),true,'后处理失败后冻结记录仍保留（刷新后可恢复）');
    assert.strictEqual((await browser.SuiteTaskStore.get(taskH.taskId)).stage,'acquired','后处理失败任务保持可重试阶段');

    // 页面刷新（内存态清空）＋ 同名但内容不同的 Excel 重导：第 7 行「材质」被改成「重导后」
    vm.runInContext('suitePendingNumbering=null;',ctx);
    const reimportedSheet = { fileName:'test.xlsx', sheetName:'S9', startRow:1, headers:POLO_HEADERS,
        rows:[ POLO_HEADERS,
            POLO_HEADERS.map(h=>poloRowValues({材质:'Silk / 丝'})[h] ?? ''),
            ...Array.from({length:4},()=>POLO_HEADERS.map(h=>poloRowValues()[h] ?? '')),
            POLO_HEADERS.map(h=>poloRowValues({材质:'重导后'})[h] ?? '') ] };
    vm.runInContext('currentSheet = __reimportedSheet;', Object.assign(ctx,{__reimportedSheet:reimportedSheet}));
    await browser.renderSuiteImages(browser.currentProduct);
    assert(vm.runInContext('suitePendingNumbering && suitePendingNumbering.restored===true',ctx),'刷新后由持久化记录恢复待确认编号');
    assert(!!vm.runInContext('suitePendingNumbering.excelRowSpec',ctx),'恢复使用的是任务启动时冻结的行规格（不是重导后的表）');
    assert(node('suiteImagesGrid').innerHTML.includes('未确认'),'恢复渲染待确认候选，不是空网格');
    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    await browser.confirmSuiteNumbering();
    // 文件名=输出编号后，重复确认会覆盖同名文件而不是新增；按编号断言仍然证明 5 张都写了
    const dirH = dir.subdirs.get('test.xlsx/row7');
    const namesH = dirH ? [...dirH.keys()] : [];
    assert.strictEqual(namesH.filter(n=>/^(111|222|333|444|666)\.png$/.test(n)).length,5,'恢复后确认成功写盘 5 张（文件名=输出编号）');
    const rec111H=(await browser.SuiteCore.ResultStore().list('test.xlsx',7)).find(r=>r.key==='111');
    assert.strictEqual(await rec111H.blob.text(),'Cotton|https://image/'+taskH.taskId+'/4','恢复任务用的是启动时冻结的「棉」，而不是重导后的「重导后」');
    assert.strictEqual((await browser.SuiteTaskStore.get(taskH.taskId)).stage,'completed','恢复后任务完成');
    assert.strictEqual(records.has('polo_suite_pending|test.xlsx|7|rowfreeze'),false,'任务完成后清理冻结记录');

    /* ---------- (I) 无法恢复：有恢复标记但冻结记录缺失 → 明确报错，绝不用当前 Excel 顶替 ---------- */
    const taskI = await browser.SuiteTaskStore.create({fileKey:'test.xlsx',rowNum:7,mode:'quick-five',targetKeys:keys,expectCount:5});
    await browser.SuiteTaskStore.advance(taskI.taskId,'sent');
    await browser.SuiteTaskStore.advance(taskI.taskId,'acquired');
    await vm.runInContext("suiteSend('suiteListTasks',{fileKey:'test.xlsx',rowNum:7})",ctx);
    // 只写「待确认记录」、不写冻结记录（模拟冻结写入丢失 / 记录损坏）
    const pendingI={ taskId:taskI.taskId, fileKey:'test.xlsx', rowNum:7, steps,
        candidates: browser.SuiteCore.buildNumberingCandidates(keys.map((_,i)=>'https://image/'+taskI.taskId+'/'+i), keys.map(k=>({key:k}))) };
    records.set('polo_suite_pending|test.xlsx|7|pending',{fileKey:'test.xlsx',rowNum:7,key:'pending',taskId:taskI.taskId,meta:{pending:structuredClone(pendingI)}});
    records.delete('polo_suite_pending|test.xlsx|7|rowfreeze');
    vm.runInContext('suitePendingNumbering=null;',ctx);
    await browser.renderSuiteImages(browser.currentProduct);
    assert(vm.runInContext('suitePendingNumbering && suitePendingNumbering.restored===true',ctx),'缺冻结记录的任务被标记为 restored');
    assert(!vm.runInContext('suitePendingNumbering.excelRowSpec',ctx),'冻结记录缺失时不得现场派生新规格（不拿当前导入的 Excel 顶替）');
    const postBeforeI=postRuns, filesBeforeI=totalFiles();
    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    await browser.confirmSuiteNumbering();
    assert(statuses[statuses.length-1].includes('无法恢复任务'),'无法恢复时明确报错并停止（'+statuses[statuses.length-1]+'）');
    assert.strictEqual(postRuns,postBeforeI,'无法恢复时不得执行后处理');
    assert.strictEqual(totalFiles(),filesBeforeI,'无法恢复时不得写盘');
    assert.strictEqual((await browser.SuiteTaskStore.get(taskI.taskId)).stage,'acquired','无法恢复时任务保持原阶段，未被静默替代');

    /* ---------- (J) 执行前后处理配置校验：空脚本在跑任何脚本前报错，且含编号+步骤名+脚本名 ---------- */
    await browser.SuiteTaskStore.cancel(taskI.taskId);
    const taskJ = await browser.SuiteTaskStore.create({fileKey:'test.xlsx',rowNum:7,mode:'quick-five',targetKeys:keys,expectCount:5});
    await browser.SuiteTaskStore.advance(taskJ.taskId,'sent');
    await browser.SuiteTaskStore.advance(taskJ.taskId,'acquired');
    await vm.runInContext("suiteSend('suiteListTasks',{fileKey:'test.xlsx',rowNum:7})",ctx);
    seedPending(taskJ.taskId);
    keys.forEach((k,i)=>node('suiteMap_'+k).value=String(4-i));
    // 面板配置切回「出厂默认五步」：占位脚本已配置但内容为空
    browser.localStorage = { getItem:k=>k==='polo_custom_step_editor_v1'?JSON.stringify({polo:browser.CustomStepDefaults}):null, setItem:()=>{} };
    const postBeforeJ=postRuns, filesBeforeJ=totalFiles();
    await browser.confirmSuiteNumbering();
    const statusJ = statuses[statuses.length-1];
    assert(statusJ.includes('后处理配置校验未通过'), '空脚本必须在执行前明确报错（'+statusJ+'）');
    assert(statusJ.includes('111') && statusJ.includes('卖点图') && statusJ.includes('111扩图.js'), '报错必须同时给出编号、步骤名与脚本名（'+statusJ+'）');
    assert.strictEqual(postRuns, postBeforeJ, '配置校验不通过时不得跑任何脚本（runAll 未被调用）');
    assert.strictEqual(totalFiles(), filesBeforeJ, '配置校验不通过时不得写盘');
    assert.strictEqual(records.has('polo_suite_pending|test.xlsx|7|rowfreeze'), true, '冻结记录已落盘（校验发生在冻结之后）');
    assert.strictEqual((await browser.SuiteTaskStore.get(taskJ.taskId)).stage, 'acquired', '配置校验不通过时任务保持可重试阶段');
    // 复原面板配置与测试数据，避免影响其他断言/环境
    browser.localStorage = { getItem:k=>k==='polo_custom_step_editor_v1'?JSON.stringify({polo:PANEL_STEPS}):null, setItem:()=>{} };
    await browser.SuiteTaskStore.cancel(taskJ.taskId);
    records.delete('polo_suite_pending|test.xlsx|7|rowfreeze');
    records.delete('polo_suite_pending|test.xlsx|7|pending');
    vm.runInContext('suitePendingNumbering=null;',ctx);

    vm.runInContext('currentSheet = __autoSheet;',Object.assign(ctx,{__autoSheet:{fileName:'test.xlsx',sheetName:'Auto',startRow:1,headers:POLO_HEADERS,rows:[POLO_HEADERS,...Array.from({length:6},()=>POLO_HEADERS.map(h=>poloRowValues()[h]??''))]}}));
    dir.permission='granted';
    // 五步混合流程：111/444 直接用产品主图后处理，222/333/666 才真正调用 AI 生成。
    const localConfig=new Map([['polo_custom_step_editor_v1',JSON.stringify({polo:PANEL_STEPS})]]);
    browser.localStorage={getItem:k=>localConfig.get(k)||null,setItem:(k,v)=>localConfig.set(k,v)};
    // 记录每一步真实进入后处理的输入，用来验证「图片来源」分流。
    const runStepLog=[];
    let failStep='';
    const actualRunStep=browser.SuitePostprocess.runStep;
    browser.SuitePostprocess.runStep=async(step,key,blob,ctxPost)=>{
        runStepLog.push({key, input: await blob.text()});
        if(key===failStep){failStep='';return {ok:false,key,error:'注入的后处理失败',applied:'customJs'};}
        return actualRunStep(step,key,blob,ctxPost);
    };
    const beforeCreates=messages.filter(m=>m.action==='suiteCreate').length;
    const beforeRuns=messages.filter(m=>m.action==='suiteRun').length;
    const beforeFiles=files.size;
    const suiteDirBeforeJ = (dir.subdirs.get('test.xlsx/row7') && [...dir.subdirs.get('test.xlsx/row7').keys()]) || [];
    await browser.startSuiteGeneration();
    const autoTask=JSON.parse(localConfig.get('polo_suite_auto_v1'));
    const newCreates=messages.filter(m=>m.action==='suiteCreate').slice(beforeCreates);
    assert.deepEqual(newCreates.map(m=>m.task.targetKeys), [['222','333','666']], '完整套图只给 222/333/666 创建合并生成请求，111/444 跳过 AI：'+JSON.stringify(newCreates.map(m=>m.task.targetKeys))+'｜'+statuses.slice(-4).join(' | '));
    assert.equal(newCreates.length,1,'一键整套只创建一个批量生图任务');
    assert.equal(newCreates[0].task.mode,'batch-gen','一键整套使用 batch-gen 模式表达合并生成三张 AI 原图');
    assert.equal(newCreates[0].task.expectCount,3,'batch-gen expectCount = AI 步骤数 3');
    assert.equal(newCreates[0].task.expectCount,newCreates[0].task.targetKeys.length,'expectCount 与 targetKeys 数量一致');
    assert.equal(messages.filter(m=>m.action==='suiteRun').length,beforeRuns+1,'完整套图只发一次合并生成请求（222/333/666 一次拿到，不是逐张多次）');
    assert.deepEqual(runStepLog.map(x=>x.key),['111','222','333','444','666'],'后处理严格按该类目配置的步骤顺序执行');
    const mainInputs=runStepLog.filter(x=>x.key==='111'||x.key==='444').map(x=>x.input);
    assert.equal(mainInputs.length,2,'111 与 444 都执行了后处理');
    assert(mainInputs[0]===mainInputs[1],'111 与 444 输入都是同一份原始产品主图（444 不复用 111 的结果）');
    assert(runStepLog.filter(x=>['222','333','666'].includes(x.key)).every(x=>/^https:\/\/image\//.test(x.input)),'AI 步骤的后处理输入是各自生成结果');
    // 落盘位置：套图与颜色图同构，进 <文件名>/rowN/ 子目录，不再平铺根层
    const suiteSubdir7=dir.subdirs.get('test.xlsx/row7');
    const KEYNAMES=['111','222','333','444','666'];
    assert(suiteSubdir7&&KEYNAMES.every(k=>suiteSubdir7.has(k+'.png')),'一键整套五张成品落在 Polo发品_颜色图/test.xlsx/row7/ 子目录，文件名=输出编号');
    assert(files.size===beforeFiles,'套图成品不进根层（根层文件数不变）');
    // 文件名直接用输出编号：同名覆盖是有意设计（重跑/重生成不产生副本）
    assert(Array.from(suiteSubdir7.keys()).filter(n=>/^(111|222|333|444|666)\.png$/.test(n)).length===5,'子目录内恰好 5 个编号文件，无历史副本堆积');
    const idxAuto=await browser.SuiteCore.ResultStore().list('test.xlsx',7);
    assert.equal(idxAuto.length,5);assert(idxAuto.every(r=>r.meta&&r.meta.verified===true),'五张成品全部校验通过');
    assert.equal(autoTask.done,5);assert.equal(autoTask.phase,'completed',statuses.slice(-3).join(' | '));
    assert.equal(autoTask.total,5,'进度按五张最终成品统计');
    assert.equal(records.has('polo_suite_pending|test.xlsx|7|fivefreeze'),false,'任务完成后清理冻结记录');
    assert.equal(vm.runInContext('suitePendingNumbering',ctx),null);

    /* ---------- (K) 原图已缓存但后处理未执行：刷新/恢复只继续后处理，不跳过、不重新生图 ---------- */
    browser.currentProduct={row:2};
    const beforeKRuns=messages.filter(m=>m.action==='suiteRun').length;
    const beforeKCreates=messages.filter(m=>m.action==='suiteCreate').length;
    failStep='222';
    await browser.startSuiteGeneration();
    const failedFiveState=browser.readSuiteAutoState();
    assert.equal(failedFiveState.phase,'error','后处理失败必须明确报错并保留已完成（'+statuses.slice(-2).join(' | ')+'）');
    const failedFive=await browser.readSuiteFive('test.xlsx',2);
    assert(failedFive&&failedFive.generated['222'],'222 的 AI 原图已缓存进冻结记录');
    assert.equal(failedFive.done['222'],undefined,'222 只有原图，没有成品记录');
    assert(failedFive.groupTaskId,'整套合并生成任务已登记到冻结记录');
    const gen222=await browser.SuiteTaskStore.get(failedFive.generated['222'].taskId);
    assert.equal(gen222.stage,'generated','batch-gen 任务结束于独立终态 generated（AI 原图已缓存，不代表成品已保存）');
    assert.equal((gen222.results||[]).every(r=>r.saved!==true),true,'generated 不得冒充成品已保存');
    assert.equal((await browser.SuiteTaskStore.list({fileKey:'test.xlsx',rowNum:2,activeOnly:true})).length,0,'batch-gen 结束后不再占用互斥，允许后续步骤开始');
    assert.equal(await browser.suiteBadgeReady('test.xlsx',2),false,'222 有原图但成品未保存，不显示套图角标');
    assert.equal(messages.filter(m=>m.action==='suiteRun').length,beforeKRuns+1,'失败前只发了一次合并生成请求（3 张一次拿到）');
    assert.equal(messages.filter(m=>m.action==='suiteCreate').length,beforeKCreates+1,'失败前只创建了一个 batch-gen 任务');
    const frozenMain=failedFive.main.dataUrl;
    assert.equal(browser.ExcelRow.build(failedFive.excelRowSpec).cell('材质'),'Cotton / 棉','冻结记录保存了任务启动时的行数据');
    // 同名 Excel 重导（第 2 行材质被改）+ 页面内存状态丢失后再继续：必须仍用冻结主图与行数据。
    vm.runInContext(`currentSheet = { fileName:'test.xlsx', sheetName:'S9', startRow:1, headers:currentSheet.headers,
        rows: currentSheet.rows.map((row,i)=> i===2 ? currentSheet.headers.map(h=>h==='类目'?'polo(2)':h==='材质'?'重导后':'') : row) };
        suiteAutoState=null;suitePendingNumbering=null;`,ctx);
    const stepsBeforeResume=runStepLog.length;
    await browser.startSuiteGeneration();
    const resumedFiveState=browser.readSuiteAutoState();
    assert.equal(resumedFiveState.phase,'completed',statuses.slice(-2).join(' | '));
    assert.equal(messages.filter(m=>m.action==='suiteRun').length,beforeKRuns+1,'恢复后不重新发合并请求，复用已缓存的三张 AI 原图');
    assert.equal(messages.filter(m=>m.action==='suiteCreate').length,beforeKCreates+1,'恢复后不新建生成任务（复用原 batch-gen 已获取结果）');
    const resumedSteps=runStepLog.slice(stepsBeforeResume);
    assert(resumedSteps.some(x=>x.key==='222'&&x.input===failedFive.generated['222'].dataUrl),'恢复后 222 用已缓存原图继续后处理');
    assert.equal(resumedSteps.find(x=>x.key==='444').input,frozenMain,'重导 Excel 后继续仍用原任务冻结的产品主图');
    const genTasks=await browser.SuiteTaskStore.list({fileKey:'test.xlsx',rowNum:2});
    assert(genTasks.filter(t=>t.mode==='batch-gen').every(t=>t.stage==='generated'),'batch-gen 任务以 generated 结束，成品语义不被占用');
    assert.equal(records.has('polo_suite_pending|test.xlsx|2|fivefreeze'),false,'整套完成后清理冻结记录');
    assert.equal(await browser.suiteBadgeReady('test.xlsx',2),true,'五张成品全部保存后才显示套图角标');
    // 恢复后的成品同样落进 row2 子目录（与颜色图同构），不进根层
    const suiteSubdir2=dir.subdirs.get('test.xlsx/row2');
    assert(suiteSubdir2&&suiteSubdir2.size===5,'row2 五张成品落在 Polo发品_颜色图/test.xlsx/row2/ 子目录');
    assert(files.size===beforeFiles,'恢复后套图成品仍不进根层');

    // 指定重生成：生产菜单 -> 生产生成入口 -> 真实后处理执行器 -> 写盘。
    vm.runInContext(fs.readFileSync(path.join(root,'targeted-regeneration.js'),'utf8'),ctx);
    const targetedStart=html.indexOf('var targetedRegenerationRunning = false;');
    vm.runInContext(html.slice(targetedStart,html.indexOf('// 轮询兜底',targetedStart)),ctx);
    const stepOrder=['444','111','222','333','666'];
    const targetedSteps=stepOrder.map(key=>({name:'图'+key,key,prompt:'generate '+key,upload:'original',mappings:[],
        postprocess:[{name:key+'对应脚本.js',code:"CustomJsSDK.run(async ({data,input})=>new Blob(['SCRIPT_"+key+"|'+data.cell('材质')+'|'+await input.text()],{type:'image/png'}));"}]}));
    localConfig.set('polo_custom_step_editor_v1',JSON.stringify({polo:targetedSteps}));
    browser.products=[{row:4},{row:7}];browser.currentProduct=browser.products[0];browser.batchColorState=null;
    let chosenInput='4(0,3)',colorCalls=0;
    browser.openTargetedRegenerationPanel=async()=>({
        input:chosenInput,
        jobs:browser.TargetedRegeneration.plan(browser.TargetedRegeneration.parse(chosenInput),browser.products,p=>browser.suiteFrozenSteps(browser.ExcelRow.build(browser.excelRowSpec(p.row))))
    });
    browser.selectProduct=index=>{browser.currentProduct=browser.products[index];};
    browser.buildRowPreviewLines=items=>items.map(p=>'行'+p.row);
    browser.beginColorBatch=items=>{colorCalls++;assert.equal(items[0].row,4);const state={running:true,successCount:0,failCount:0};browser.batchColorState=state;setTimeout(()=>{state.successCount=1;state.running=false;},0);};
    const beforeTargetRuns=messages.filter(m=>m.action==='suiteRun').length,beforeTargetSteps=runStepLog.length;
    const previousTaskId=browser.readSuiteAutoState().taskId;
    await browser.startColorChangeForRows();
    const targetedTask=browser.readSuiteAutoState();
    assert.notEqual(targetedTask.taskId,previousTaskId,statuses.slice(-5).join(' | '));
    assert.equal(colorCalls,1);assert.equal(messages.filter(m=>m.action==='suiteRun').length,beforeTargetRuns+1);
    assert.equal(runStepLog.length,beforeTargetSteps+1,'指定重生成只后处理选中的那一个步骤');assert.equal(targetedTask.phase,'completed');
    const taskRecord=messages.filter(m=>m.action==='suiteCreate').slice(-1)[0].task;
    assert.deepEqual(Array.from(taskRecord.targetKeys),['222'],'step 3 uses current saved configuration order');
    const writtenTarget=await browser.SuiteCore.ResultStore().get('test.xlsx',4,'222');
    assert((await writtenTarget.blob.text()).startsWith('SCRIPT_222|Cotton|'),'only the selected step script processes the frozen task row');
    assert(!(await writtenTarget.blob.text()).includes('SCRIPT_444'),'other step script must not run');
    assert.equal(await browser.SuiteCore.ResultStore().get('test.xlsx',4,'444'),null,'unselected step is not saved');
    // 已配置但空脚本：在发送生成请求前停止；不能误用上一任务 completed 状态报告成功。
    targetedSteps[2].postprocess[0].code='';
    localConfig.set('polo_custom_step_editor_v1',JSON.stringify({polo:targetedSteps}));chosenInput='4(3)';
    const emptyRuns=messages.filter(m=>m.action==='suiteRun').length,emptySteps=runStepLog.length,emptyStatuses=statuses.length;
    await browser.startColorChangeForRows();
    assert.equal(messages.filter(m=>m.action==='suiteRun').length,emptyRuns);assert.equal(runStepLog.length,emptySteps,'空脚本在预检就失败，不进入后处理');
    assert(!statuses.slice(emptyStatuses).some(m=>m.includes('指定重生成全部完成')));
    assert(statuses.slice(emptyStatuses).some(m=>m.includes('脚本为空')));
    assert.equal(vm.runInContext('targetedRegenerationRunning',ctx),false);
    console.log('PASS targeted production entry: 4(0,3) -> color + config step 3 -> matching 222 script -> frozen row -> saved output; empty script blocks request and cannot reuse previous completion');

    console.log('PASS automatic five-step suite: 一键整套只发 1 次合并生成请求（batch-gen, expectCount=3, targetKeys=222/333/666）；111/444 直接用同一冻结产品主图后处理、无 AI 请求；后处理按配置顺序执行；五张成品落进 <文件名>/rowN/ 子目录并校验；五张齐全才显示套图角标；后处理失败恢复复用已缓存原图不重新生图');
    console.log('PASS production page: single-step regeneration routes through the same five-step pipeline (one request for 222, no generation for 111/444); confirmation/freeze/render/disk-verify legacy paths still guarded');
})().catch(e=>{console.error(e);process.exitCode=1;});


