(() => {
 const box=document.createElement('details');box.innerHTML='<summary>AI 标题精简 API 配置</summary><label>接口地址<input id="titleApiUrl" type="url" placeholder="https://api.deepseek.com/chat/completions"></label><label>模型<input id="titleApiModel" placeholder="deepseek-chat"></label><label>API Key<input id="titleApiKey" type="password" autocomplete="off"></label><button type="button" id="titleApiSave">保存 API 配置</button><p id="titleApiNotice" role="status"></p>';
 document.getElementById('open-helper').before(box);
 const url=box.querySelector('#titleApiUrl'),model=box.querySelector('#titleApiModel'),key=box.querySelector('#titleApiKey'),notice=box.querySelector('#titleApiNotice');let config={};
 (async()=>{const saved=await chrome.storage.local.get('polo_deepseek_config');config=saved.polo_deepseek_config||{};
 if(!config.apiKey){try{config=(await(await fetch(chrome.runtime.getURL('js代码/api_config.json'))).json()).deepseek||{};if(config.apiKey)await chrome.storage.local.set({polo_deepseek_config:config});}catch(_){}}
 url.value=config.url||'https://api.deepseek.com/chat/completions';model.value=config.model||'deepseek-chat';key.placeholder=config.apiKey?'已配置，留空保留原 Key':'请输入 API Key';})();
 box.querySelector('#titleApiSave').onclick=async()=>{try{const endpoint=new URL(url.value);if(endpoint.protocol!=='https:')throw Error('接口地址请使用 HTTPS');const next={...config,url:endpoint.href,model:model.value.trim()||'deepseek-chat',apiKey:key.value.trim()||config.apiKey};if(!next.apiKey)throw Error('请输入 API Key');await chrome.storage.local.set({polo_deepseek_config:next});config=next;key.value='';key.placeholder='已配置，留空保留原 Key';notice.textContent='已保存，标题精简脚本直接使用此配置';}catch(e){notice.textContent=e.message;}};
})();
