const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
const source=fs.readFileSync('chrome_extension/background.js','utf8');
const start=source.indexOf('async function fetchColorImageAsBase64('),end=source.indexOf('const PS_SAVE_MARKER',start);
const folder='卫衣_全部合并_已审核_重填版_Non-hooded sweatshirt';
const root=path.join(os.homedir(),'Downloads','Polo发品_颜色图');let cached=0;
const context={console,Blob,btoa,Uint8Array,COLOR_IMG_DIR:root,CURRENT_FILENAME:folder,DEFAULT_FILE_FOLDER:'默认',getFilePrefix:()=> 'book',PoloDirectories:{isColorSelection:()=>false},isRasterImageType:type=>type==='image/png',buildColorImagePath:(row,color,ctx)=>path.join(ctx.colorImgDir,ctx.fileFolder,'row'+row,'row'+row+'_'+color+'.png'),getColorImageFromIDB:()=>{cached++;throw Error('must not use cache');},fetch:async(url,options)=>{assert.equal(url,'http://127.0.0.1:8765/local-image');const request=JSON.parse(options.body);assert.equal(request.root,root);try{const data=await fs.promises.readFile(request.path);return {ok:true,blob:async()=>new Blob([data],{type:'image/png'})};}catch(error){return {ok:false,status:error.code==='ENOENT'?404:500};}}};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
(async()=>{
 for(const color of ['black','gray','navy']){const actual=path.join(root,folder,'row2','row2_'+color+'.png');assert(fs.existsSync(actual),'real fixture missing: '+actual);const result=await context.fetchColorImageAsBase64(2,color,'book');assert.equal(result.ok,true);assert.equal(result.fromDisk,true);assert.equal(Buffer.from(result.dataUrl.split(',')[1],'base64').length,fs.statSync(actual).size);}
 assert.equal((await context.fetchColorImageAsBase64(2,'white','book')).ok,false);
 assert.equal((await context.fetchColorImageAsBase64(2,'black','wrong')).ok,false);assert.equal(cached,0);
 console.log('PASS production absolute-path branch + real disk files: black/gray/navy read, missing white rejected, no cache fallback, wrong workbook rejected (Node file transport; browser transport separately required)');
})().catch(error=>{console.error(error);process.exitCode=1;});
