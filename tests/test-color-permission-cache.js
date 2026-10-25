const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('chrome_extension/background.js','utf8');const start=source.indexOf('async function fetchColorImageAsBase64('),end=source.indexOf("const PS_SAVE_MARKER",start);
let readKey;
const ctx={console,CURRENT_FILENAME:'测试表',COLOR_IMG_DIR:'polo-dir:bound',DEFAULT_FILE_FOLDER:'默认',getFilePrefix:()=> '测试表__',PoloDirectories:{isColorSelection:()=>true,colorImage:async()=>{throw new Error('需要重新授权');}},colorImageIDBKey:(name,row,color)=>[name,row,color].join('/'),getColorImageFromIDB:async key=>{readKey=key;return 'data:image/png;base64,Y2FjaGU=';}};
vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
(async()=>{const result=await ctx.fetchColorImageAsBase64(2,'white','测试表__');assert.equal(result.ok,true);assert.equal(result.dataUrl,'data:image/png;base64,Y2FjaGU=');assert.equal(readKey,'测试表/2/white');readKey=null;assert.equal((await ctx.fetchColorImageAsBase64(2,'white','其他表__')).ok,false);assert.equal(readKey,null);console.log('PASS 目录待授权仍读取同产品图片缓存，错误文件身份不可读缓存');})().catch(e=>{console.error(e);process.exitCode=1;});
