const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../发品助手.html'),'utf8');
const code=html.slice(html.indexOf('function openImportCache()'),html.indexOf('let selectedRows = new Set()'));
let stored;
const local=new Map();
function page(){
    const env={structuredClone,console,products:[],currentSheet:null,currentColMap:{},loadedFileName:'',
        localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},
        document:{getElementById:()=>({style:{}})},chrome:{runtime:null},
        setTimeout:()=>{},renderProductList(){},startUploadPolling(){},selectProduct(){},showToast(){},
        indexedDB:{open(){const req={};queueMicrotask(()=>{req.result={close(){},transaction(){
            const tx={objectStore:()=>({put(value){stored=structuredClone(value);queueMicrotask(()=>tx.oncomplete());},get(){const result={};queueMicrotask(()=>{result.result=structuredClone(stored);result.onsuccess();});return result;}})};return tx;
        }};req.onsuccess();});return req;}}
    };
    vm.createContext(env);vm.runInContext(code,env);return env;
}
(async()=>{
    const first=page();
    first.currentSheet={fileName:'卫衣.xlsx',sheetName:'Sheet1',startRow:1,headers:['材质','克重'],rows:[['材质','克重'],['棉',0]]};
    first.products=[{row:2,id:'p1',category:'卫衣',image:'data:image/png;base64,example'}];
    first.currentColMap={material:0};first.loadedFileName='卫衣';
    await first.saveToLocalStorage();
    const refreshed=page();assert.equal(await refreshed.loadFromLocalStorage(),true);
    assert.deepEqual(refreshed.currentSheet,first.currentSheet);
    assert.deepEqual(refreshed.products,first.products);
    assert.deepEqual(refreshed.currentColMap,first.currentColMap);
    assert.equal(refreshed.loadedFileName,'卫衣');
    const reimported=page();reimported.currentSheet={fileName:'新.xlsx'};
    assert.equal(await reimported.loadFromLocalStorage(),false);
    assert.equal(reimported.currentSheet.fileName,'新.xlsx');
    stored={version:1,products:first.products};
    const incomplete=page();assert.equal(await incomplete.loadFromLocalStorage(),false);
    assert.equal(incomplete.products.length,0);assert.equal(incomplete.currentSheet,null);
    console.log('PASS full workbook restore, zero values, products/images, mapping, manual import precedence, incomplete cache rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});
