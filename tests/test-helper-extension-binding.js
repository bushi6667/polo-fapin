const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('发品助手.html','utf8').replace(/\r\n/g,'\n'),popup=fs.readFileSync('chrome_extension/popup.js','utf8');
assert(!html.includes('id="extIdBtn"'));assert(!html.includes('function promptExtensionId('));
const start=html.indexOf('try {\n    const launch = new URL(location.href);'),end=html.indexOf('let EXTENSION_ID',start);
function launch(href,previous){const store=new Map(previous?[['polo_extension_id',previous]]:[]);let replaced=null;const ctx={URL,location:{href},history:{replaceState:(a,b,url)=>replaced=url},localStorage:{setItem:(k,v)=>store.set(k,v)},console};vm.runInNewContext(html.slice(start,end),ctx);return{store,replaced};}
const id='a'.repeat(32),url='file:///C:/project/发品助手.html?poloExtension='+id;
const bound=launch(url);assert.equal(bound.store.get('polo_extension_id'),id);assert(!bound.replaced.includes('poloExtension'));assert(bound.replaced.startsWith('file:'));
assert.equal(launch('file:///C:/project/发品助手.html','old').store.get('polo_extension_id'),'old');assert.equal(launch('file:///C:/project/发品助手.html?poloExtension=invalid','old').store.get('polo_extension_id'),'old');
let click,created;const openStart=popup.indexOf("document.getElementById('open-helper').addEventListener"),openEnd=popup.indexOf("document.getElementById('open-publish')",openStart);
vm.runInNewContext(popup.slice(openStart,openEnd),{URL,helperPath:'C:/project/发品助手.html',pathToFileUrl:()=> 'file:///C:/project/发品助手.html',document:{getElementById:()=>({addEventListener:(e,fn)=>click=fn})},chrome:{runtime:{id},tabs:{create:args=>created=args}},alert:()=>{throw new Error('unexpected alert');}});click();assert.equal(new URL(created.url).searchParams.get('poloExtension'),id);
console.log('PASS 删除助手设置入口、扩展打开自动绑定、启动参数移除、旧连接保留、非法ID不覆盖');
