const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('发品助手.html','utf8'),background=fs.readFileSync('chrome_extension/background.js','utf8');
function section(start,end){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));}
let renders=0,polls=0,syncs=0;const loaded=[],messages=[];
const env={console,EXTENSION_ID:'test',extensionInstalled:false,extensionPort:null,products:[{row:4}],currentProduct:{row:4},colorImgBaseDir:'',localStorage:{setItem(){}},setTimeout,updateExtensionStatus(){},checkExtensionReloaded(){},refreshPublishState(){},renderProductList(){renders++;},startUploadPolling(){polls++;},syncProductToExtension(){syncs++;},loadColorImagesFromExtension:r=>loaded.push(r),chrome:{runtime:{lastError:null,sendMessage(id,req,cb){messages.push(req);cb(req.action==='ping'?{ok:true}:{ok:true,config:{colorImgDir:'configured-directory'}});},connect(){return{onMessage:{addListener(){}},onDisconnect:{addListener(){}}};}}}};
vm.createContext(env);vm.runInContext(section('function checkExtension()','function updateExtensionStatus()'),env);
env.checkExtension();assert.equal(renders,1);assert.equal(polls,1);assert.equal(syncs,1);assert.equal(loaded.length,2,'reload after directory arrives as well as reconnect');
env.checkExtension();assert.equal(renders,1,'healthy pings do not replay list entry animations');
env.extensionPort=null;env.checkExtension();assert.equal(renders,2,'port disconnect refetches uploaded records even if installed flag remains true');
// Extension-side color lookup must use caller file identity, not mutable global CURRENT_FILENAME.
const block=background.slice(background.indexOf("    if (request.action === 'getColorImagesInfo')"),background.indexOf("    if (request.action === 'getColorImagePath')"));
let readKey,response;const bg={request:{action:'getColorImagesInfo',rowNum:4,fileKey:'original__'},getFilePrefix:()=> 'different__',sendResponse:r=>response=r,chrome:{storage:{local:{get(k,cb){readKey=k;cb({[k]:{white:{},black:{},gray:{},navy:{}}});}}}}};
vm.runInNewContext('(function(){'+block+'})()',bg);assert.equal(readKey,'original__color__4');assert.equal(response.fileKey,'original__');assert.equal(response.images.length,4);
// An unavailable extension must not replace a previously loaded same-file upload map with empty data.
const render=section('function renderProductList()','function checkColorGeneratedStatus()');
const product={row:4,category:'polo',title_en:'Product'};
const cards={innerHTML:'',querySelectorAll:()=>[]};const nodes={productList:{style:{}},productCount:{},productCards:cards};
const page={console,products:[product],document:{getElementById:id=>nodes[id]},currentFileKey:()=> 'original__',uploadedRowsFileKey:'original__',uploadedRows:{4:true},legacyRows:{},selectedRows:new Set(),currentColMap:{},checkColorGeneratedStatus(){},checkSuiteGeneratedStatus(){},renderSuiteAutoControls(){},updateBatchBar(){},chrome:{runtime:{lastError:{message:'disconnected'},sendMessage(id,req,cb){cb();}}},EXTENSION_ID:'test'};
vm.createContext(page);vm.runInContext(render,page);page.renderProductList();assert(page.uploadedRows[4]);assert(cards.innerHTML.includes('已保存'));
page.currentFileKey=()=> 'other__';page.renderProductList();assert(!page.uploadedRows[4],'never borrow upload records from another Excel');
console.log('PASS reconnect refetches records, directory reloads images, healthy ping avoids rerender, color lookup binds Excel identity, transient failure preserves same-file upload badges without crossing files');

(async()=>{
const trust=background.slice(background.indexOf('async function isTrustedSender('),background.indexOf('// M3：'));
const env={URL,decodeURIComponent,HELPER_PATH_KEY:'helper',chrome:{storage:{local:{get(key,callback){callback({helper:'C:\\project\\发品助手.html'});}}}}};
vm.createContext(env);vm.runInContext(trust,env);
for(const url of ['http://localhost:8765/发品助手.html','http://127.0.0.1:8765/%E5%8F%91%E5%93%81%E5%8A%A9%E6%89%8B.html'])assert(await env.isTrustedSender({url}));
for(const url of ['http://localhost:8766/发品助手.html','http://localhost:8765/evil.html','http://example.com:8765/发品助手.html','http://localhost.evil.com:8765/发品助手.html','chrome-extension://other/popup.html'])assert.equal(await env.isTrustedSender({url}),false,url);
console.log('PASS local helper trust is restricted to exact loopback host, port and page; other extension origins remain rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});
