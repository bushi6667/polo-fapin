'use strict';
const SuiteRuntime = (() => {
    // 看板仍可从 file:// 打开；计算资源由扩展提供，不要求启动 Node 服务。
    function url(path) {
        const id = typeof EXTENSION_ID !== 'undefined' ? EXTENSION_ID : '';
        if (!/^[a-p]{32}$/.test(id)) throw new Error('尚未连接扩展，请确认 Polo 扩展已启用');
        const resource = String(path).replace(/^chrome_extension\//, '');
        return new URL(resource, 'chrome-extension://' + id + '/').href;
    }
    let loading;
    async function ready() {
        if(window.ort)return;
        if(!loading)loading=new Promise((resolve,reject)=>{
            const script=document.createElement('script');script.src=url('runtime/ort.min.js');
            script.onload=()=>{if(window.ort)resolve();else{loading=null;reject(new Error('扩展图片处理引擎初始化失败'));}};
            script.onerror=()=>{loading=null;script.remove();reject(new Error('扩展图片处理资源加载失败，请重新加载扩展并刷新看板'));};document.head.appendChild(script);
        });
        await loading;
    }
    async function readJson(name) {
        const response=await fetch(url('chrome_extension/js代码/'+name));
        if(!response.ok)throw new Error('脚本配置读取失败：'+name);
        return response.json();
    }
    function imageUrl(source) {
        return source;
    }
    return {url,ready,readJson,imageUrl};
})();
globalThis.SuiteRuntime=SuiteRuntime;
