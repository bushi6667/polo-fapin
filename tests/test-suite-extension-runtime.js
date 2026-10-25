const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chrome_extension/manifest.json')));
const exposed = manifest.web_accessible_resources.flatMap(x => x.resources);
const context = {
    EXTENSION_ID: 'kjhcjbhfficelpcjcnlieemgclkbfied', URL,
    window: {}, location: {href:'file:///C:/polo/发品助手.html',protocol:'file:'},
    document: {createElement: () => ({remove(){}}),head:{appendChild(script){
        assert(script.src.startsWith('chrome-extension://'));
        context.window.ort = {env:{wasm:{}}}; script.onload();
    }}},
    fetch: async url => {assert(url.startsWith('chrome-extension://'));return {ok:true,json:async()=>({brands:[]})};}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root,'chrome_extension/suite/suite-runtime.js'),'utf8'), context);
(async () => {
    for(const resource of ['runtime/ort.min.js','runtime/ort-wasm.wasm','runtime/ort-wasm-simd.wasm','runtime/u2net.onnx','js代码/brand_blacklist.json']) {
        assert(exposed.includes(resource), resource+' must be exposed');
        assert(fs.statSync(path.join(root,'chrome_extension',resource)).size > 0);
        assert.equal(decodeURI(context.SuiteRuntime.url(resource)),'chrome-extension://'+context.EXTENSION_ID+'/'+resource);
    }
    await context.SuiteRuntime.ready();
    await context.SuiteRuntime.readJson('brand_blacklist.json');
    assert.equal(context.SuiteRuntime.imageUrl('extracted_images/main.png'),'extracted_images/main.png');
    context.EXTENSION_ID='';
    assert.throws(()=>context.SuiteRuntime.url('runtime/'),/尚未连接扩展/);
    console.log('PASS extension resources, model files, engine initialization, JSON and no local server');
})().catch(e=>{console.error(e);process.exitCode=1;});
