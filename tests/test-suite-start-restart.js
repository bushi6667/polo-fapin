const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'发品助手.html'),'utf8');
const background=fs.readFileSync(path.join(root,'chrome_extension/background.js'),'utf8');
(async()=>{
    let tabs=[],created=0,focused=0;
    const page={DOUBAO_URL:'https://www.doubao.com/chat',findDoubaoTab:async()=>tabs[0],chrome:{
        tabs:{create:async()=>{created++;const tab={id:9,windowId:1};tabs.push(tab);return tab;},update:async()=>{}},
        windows:{update:async()=>{focused++;}}
    }};
    vm.createContext(page);
    vm.runInContext(background.slice(background.indexOf('let suitePagePreparing ='),background.indexOf('async function findDoubaoTab()')),page);
    await Promise.all([page.prepareSuiteDoubaoPage(),page.prepareSuiteDoubaoPage()]);
    assert.equal(created,1,'concurrent prepare must not open duplicate tabs');
    await page.prepareSuiteDoubaoPage();assert.equal(created,1,'reuse existing Doubao tab');assert.equal(focused,2);
    tabs=[];await page.prepareSuiteDoubaoPage();assert.equal(created,2,'reopen closed Doubao page');
    const calls=[];
    const state={fileKey:'book',rowNum:3,phase:'error',paused:false};
    const resume={suiteTaskRunning:false,readSuiteAutoState:()=>state,currentProduct:{row:3},currentFileKey:()=> 'book',SUITE_STEP_KEYS:['111','444','222','333','666'],runSuiteFiveJob:async arg=>calls.push(arg)};
    vm.createContext(resume);
    vm.runInContext(html.slice(html.indexOf('async function resumeSuiteAuto()'),html.indexOf('async function waitSuiteAutoImages(')),resume);
    await resume.resumeSuiteAuto();
    assert.equal(calls.length,1);assert.equal(calls[0].restart,true,'继续=整套重做');assert.equal(calls[0].resume,undefined);
    assert.equal(calls[0].keys.length,5,'continue regenerates the entire current suite');
    state.paused=true;await resume.resumeSuiteAuto();assert.equal(calls.length,1);
    for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/src\s*=/.test(m[1])&&m[2].trim())new vm.Script(m[2]);
    console.log('PASS immediate page reuse/create, concurrent open deduplication, closed page reopening, whole-suite restart and script syntax');
})().catch(e=>{console.error(e);process.exitCode=1;});
