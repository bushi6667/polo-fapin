// 图片后缀兼容：磁盘上 png / jpg 混存时，读取与上传都按实际命中的后缀处理，不写死其中一种。
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const {webcrypto}=require('node:crypto');

// ---------- page-directories：readPsImage / pageReadColor 双后缀 ----------
function makeDir(name,files){
    const children=new Map(files);
    return {name,kind:'directory',permission:'granted',
        async queryPermission(){return this.permission;},
        async requestPermission(){return this.permission;},
        async isSameEntry(other){return other===this;},
        async getDirectoryHandle(n,o){if(!children.has(n)){if(!o?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});children.set(n,makeDir(n,[]));}return children.get(n);},
        async getFileHandle(n,o){if(!children.has(n)){if(!o?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});children.set(n,fakeFile(n,new Blob([])));}return children.get(n);},
        async *entries(){yield* children.entries();}};
}
function fakeFile(n,blob){return {name:n,kind:'file',async getFile(){return blob;},async createWritable(){return {async write(b){blob=b;},async close(){},async abort(){}};}};}
function imageDirFixture(names){
    // 产品原图目录：rowN_main.* 直接在根层
    return makeDir('产品原图目录',names.map(n=>[n,fakeFile(n,new Blob([n],{type:/\.png$/i.test(n)?'image/png':'image/jpeg'}))]));
}
class Reader{readAsDataURL(b){b.arrayBuffer().then(a=>{this.result='data:'+b.type+';base64,'+Buffer.from(a).toString('base64');this.onload();});}}
function runPage(files){
    const saved=new Map();
    const env={window:{showDirectoryPicker:async()=>root},console,Blob,Uint8Array,Map,Promise,Array,String,Error,crypto:webcrypto,FileReader:Reader,fetch,createImageBitmap:async()=>({width:256,height:256,close(){}}),indexedDB:{open(){const req={};queueMicrotask(()=>{req.result={close(){},transaction(){const tx={objectStore(){return {get(k){const r={};queueMicrotask(()=>{r.result=saved.get(k);r.onsuccess();});return r;},put(v,k){saved.set(k,v);queueMicrotask(()=>tx.oncomplete());}};}};return tx;}};req.onsuccess();});return req;}}};
    const root=files;
    vm.createContext(env);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../page-directories.js'),'utf8'),env);
    return env.window.PageDirectories;
}
(async()=>{
    // ① 只有 png，按 .jpg 请求 → 读到 png，并回报真实文件名
    let api=runPage(imageDirFixture(['row3_main.png']));
    await api.ready;await api.choose('imageDir');
    let got=await api.dispatch({action:'readPsImage',fileName:'row3_main.jpg'});
    assert.equal(got.ok,true,'png 存量在 .jpg 请求下也能读到');
    assert.equal(got.filename,'row3_main.png','返回实际命中的文件名');
    assert.equal(got.type,'image/png','类型跟随真实文件');

    // ② 只有 jpg，按 .png 请求 → 读到 jpg
    api=runPage(imageDirFixture(['row3_main.jpg']));
    await api.ready;await api.choose('imageDir');
    got=await api.dispatch({action:'readPsImage',fileName:'row3_main.png'});
    assert.equal(got.ok,true,'jpg 存量在 .png 请求下也能读到');
    assert.equal(got.filename,'row3_main.jpg','返回实际命中的文件名');
    assert.equal(got.ext,'jpg','回报实际后缀');

    // ③ 两种都没有 → 仍然如实报缺失（不假装成功）
    api=runPage(imageDirFixture(['row9_main.png']));
    await api.ready;await api.choose('imageDir');
    await assert.rejects(()=>api.dispatch({action:'readPsImage',fileName:'row3_main.jpg'}),/不存在/,'两种后缀都没有时如实报缺失');

    // ③-b webp 存量同样兼容
    api=runPage(imageDirFixture(['row3_main.webp']));
    await api.ready;await api.choose('imageDir');
    got=await api.dispatch({action:'readPsImage',fileName:'row3_main.jpg'});
    assert.equal(got.ext,'webp','webp 存量同样能读到并回报真实后缀');

    // ⑤ 两种后缀同时存在 → 按请求名优先，不乱换
    api=runPage(imageDirFixture(['row3_main.png','row3_main.jpg']));
    await api.ready;await api.choose('imageDir');
    assert.equal((await api.dispatch({action:'readPsImage',fileName:'row3_main.png'})).filename,'row3_main.png','同名两种都在时 .png 请求命中 .png');
    assert.equal((await api.dispatch({action:'readPsImage',fileName:'row3_main.jpg'})).filename,'row3_main.jpg','同名两种都在时 .jpg 请求命中 .jpg');

    // ⑥ 精确名是 0 字节残留 → 回退到另一个后缀的正常文件
    api=runPage(makeDir('产品原图目录',[
        ['row3_main.png',fakeFile('row3_main.png',new Blob([],{type:'image/png'}))],
        ['row3_main.jpg',fakeFile('row3_main.jpg',new Blob(['ok'],{type:'image/jpeg'}))]]));
    await api.ready;await api.choose('imageDir');
    got=await api.dispatch({action:'readPsImage',fileName:'row3_main.png'});
    assert.equal(got.filename,'row3_main.jpg','空文件残留时回退到另一后缀');

    // ④ 颜色图：只有 jpg 也能读到
    const colorRoot=makeDir('Polo发品_颜色图',[['book',makeDir('book',[['row3',makeDir('row3',[['row3_white.jpg',fakeFile('row3_white.jpg',new Blob(['x'],{type:'image/jpeg'}))]])]])]]);
    api=runPage(colorRoot);await api.ready;await api.choose('colorImgDir');
    const color=await api.dispatch({action:'pageReadColor',fileFolder:'book',rowNum:3,color:'white'});
    assert.equal(color.ok,true,'颜色图 jpg 也能读到');
    assert.equal(color.ext,'jpg','颜色图回报实际后缀');

    // ---------- publication-images：上传文件名跟随真实类型 ----------
    const env={Blob,btoa};vm.createContext(env);
    vm.runInContext(fs.readFileSync('chrome_extension/upload/publication-images.js','utf8'),env);
    const prepare=env.PublicationImages.prepare;
    const bank=async()=>new Blob(['bank'],{type:'image/jpeg'});
    const product={category:'polo',row:2,_publishFileKey:'k'};
    const pngMain=await prepare(product,'main',async r=>Array.from(r.keys).map(key=>({key,dataUrl:'data:image/png;base64,dGVzdA=='})),bank);
    assert.deepEqual(Array.from(pngMain.files.slice(0,2),f=>f.name),['444.png','111.png'],'png 成品按 .png 命名');
    const jpgMain=await prepare(product,'main',async r=>Array.from(r.keys).map(key=>({key,dataUrl:'data:image/jpeg;base64,dGVzdA=='})),bank);
    assert.deepEqual(Array.from(jpgMain.files.slice(0,2),f=>f.name),['444.jpg','111.jpg'],'jpeg 成品按 .jpg 命名');
    assert.equal(jpgMain.files.length,6,'主图仍是 2 张成品 + 4 张公共图');

    console.log('PASS 原图/颜色图 png-jpg 双向兼容读取 + 上传文件名跟随真实类型');
})().catch(e=>{console.error(e);process.exitCode=1;});
