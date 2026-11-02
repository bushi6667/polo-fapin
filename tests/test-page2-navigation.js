const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../chrome_extension/content/page2.js'),'utf8').replace(/\r\n/g,'\n');
const helper=source.slice(source.indexOf('function isPage3Destination'),source.indexOf('let hiddenFileInput'));
const start=source.indexOf('    // ---------- 批量模式：自动点发布跳页3 ----------');
const block=source.slice(start,source.indexOf('\n}\n',start));
assert(start>0&&block.includes('page2-jump-failed'));
async function scenario(destination){
 let clicks=0,aborts=0;const logs=[];
 const location={hostname:'post.alibaba.com',pathname:'/product/easyListing.htm'};
 const button={innerText:'我已阅读如上规则，现在发布产品',disabled:false,offsetHeight:40,getAttribute:()=>null,scrollIntoView(){}};
 const context={location,document:{querySelector:()=>({id:'scImages'}),querySelectorAll:()=>[button]},window:{},getRowFromUrl:()=>2,
  log:message=>logs.push(message),setTimeout:cb=>cb(),realClick:async()=>{clicks++;if(destination)Object.assign(location,destination);},abortRow:async()=>{aborts++;}};
 vm.createContext(context);vm.runInContext(helper,context);
 await vm.runInContext('(async()=>{'+block+'})()',context);
 return {clicks,aborts,logs};
}
(async()=>{
 const ctx={};vm.createContext(ctx);vm.runInContext(helper+';this.check=isPage3Destination;',ctx);
 assert.equal(ctx.check({hostname:'post.alibaba.com',pathname:'/product/easyListing.htm'}),false);
 assert.equal(ctx.check({hostname:'post.alibaba.com',pathname:'/product/publish.htm'}),true);
 assert.equal(ctx.check({hostname:'post.alibaba.com',pathname:'/product/publish'}),true);
 assert.equal(ctx.check({hostname:'login.alibaba.com',pathname:'/product/publish.htm'}),false);
 assert.equal(ctx.check({hostname:'post.alibaba.com',pathname:'/login.htm'}),false);
 const success=await scenario({pathname:'/product/publish.htm'});
 assert.equal(success.clicks,1,'共享scImages不能导致跳过第一次点击');assert.equal(success.aborts,0);
 assert(success.logs.some(x=>x.includes('已跳转页3')));
 const noChange=await scenario();assert.equal(noChange.clicks,2);assert.equal(noChange.aborts,1);
 const login=await scenario({hostname:'login.alibaba.com',pathname:'/login.htm'});
 assert.equal(login.aborts,1,'跳到登录页面不能冒充页3成功');
 assert(!login.logs.some(x=>x.includes('✅ 已跳转页3')));
 console.log('PASS page2 navigation: shared image DOM, real click, destination, no-op and login rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});
