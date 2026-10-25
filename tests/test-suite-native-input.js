const fs=require('fs'), path=require('path'), vm=require('vm'), assert=require('assert');
let handler;const commands=[];let cancelled=false;
const env={__suiteExecLock:{taskId:'s1',tabId:9},SuiteTaskStore:{get:async()=>({stage:'received',cancelled}),isTerminal:s=>s==='completed'},chrome:{runtime:{onMessage:{addListener:f=>handler=f}},debugger:{attach:async t=>commands.push(['attach',t]),detach:async t=>commands.push(['detach',t]),sendCommand:async(t,a,b)=>commands.push([a,b])}}};
env.globalThis=env;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/suite/suite-native-input.js'),'utf8'),env);
function send(command,character,tab=9){return new Promise(resolve=>handler({action:'doubao-native-input',command,character},{tab:{id:tab},frameId:0},resolve));}
(async()=>{
 assert.strictEqual((await send('begin')).success,true);
 assert.strictEqual((await send('clear')).success,true);
 assert.strictEqual((await send('character','abc')).success,true);
 assert.strictEqual((await send('character','\n')).success,true);
 assert(commands.some(c=>c[0]==='Input.insertText'&&c[1].text==='abc'));
 assert(commands.filter(c=>c[0]==='Input.dispatchKeyEvent'&&c[1].key==='Enter').every(c=>c[1].modifiers===8),'only Shift+Enter during input');
 const n=commands.length;
 assert.strictEqual((await send('character','\r')).success,false);
 assert.strictEqual((await send('character','bad',10)).success,false);
 cancelled=true;assert.strictEqual((await send('character','bad')).success,false);
 assert.strictEqual(commands.length,n,'rejected commands have no side effects');
 cancelled=false;await send('end');assert.strictEqual(env.__suiteExecLock.nativeAttached,false);
 console.log('PASS native bridge: bound tab, attach/clear/text/Shift+Enter/detach, forbidden Enter, cancel, no side effects');
})().catch(e=>{console.error(e);process.exitCode=1;});
