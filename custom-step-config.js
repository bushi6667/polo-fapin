/* 新配置只保存草稿与预览，不调用已移除的旧生图链路。
 * 结构参考参考扩展 pages/step-config/modal.js；原图与Excel映射按本项目的数据来源改写。 */
(() => {
    const STORAGE = 'polo_custom_step_editor_v1';
    const categories = [['polo','Polo'],['tshirt','T-shirt'],['shirt','Shirt'],['hoodie','Hooded sweatshirt'],['sweatshirt','Non-hooded sweatshirt']];
    // 界面类目键 ↔ CategoryFieldRules 的规范类目名。类目只在这里换算，存储仍按界面键。
    const canonicalCategory = { polo: 'polo', tshirt: 't-shirt', shirt: 'shirt', hoodie: 'hooded-sweatshirt', sweatshirt: 'non-hooded-sweatshirt' };
    const uiCategory = { 'polo': 'polo', 't-shirt': 'tshirt', 'shirt': 'shirt', 'hooded-sweatshirt': 'hoodie', 'non-hooded-sweatshirt': 'sweatshirt' };
    const uiKeyOf = canonical => uiCategory[canonical] || '';
    const canonicalOf = uiKey => canonicalCategory[uiKey] || '';
    const clone = value => JSON.parse(JSON.stringify(value));
    const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    // 图片来源与上传参考图（upload）是两件事：imageSource 决定进入后处理的图片来源。
    const PRODUCT_SOURCE_KEYS = new Set(['111', '444']);
    const defaultImageSource = key => PRODUCT_SOURCE_KEYS.has(String(key || '').trim()) ? 'product' : 'generated';
    const imageSourceOf = step => step && step.imageSource === 'product' ? 'product' : defaultImageSource(step && step.key);
    let state = null;

    function read() {
        const raw = localStorage.getItem(STORAGE);
        if (!raw) return {};
        const config = JSON.parse(raw);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('步骤配置格式错误，原数据已保留');
        // 迁移：只补齐缺失的图片来源，不覆盖用户已有的步骤顺序、提示词、映射、脚本与资源。
        for(const steps of Object.values(config))if(Array.isArray(steps))for(const step of steps){
            if(step.imageSource!=='product'&&step.imageSource!=='generated')step.imageSource=defaultImageSource(step.key);
        }
        // 补齐各类目的内置空占位脚本；已导入或手动修改的代码保持原样。
        for(const steps of Object.values(config))if(Array.isArray(steps))for(const step of steps)for(const script of step.postprocess||[]){
            const builtin=window.CustomStepBuiltinScripts?.[script.name];
            if(!String(script.code||'').trim()&&builtin)Object.assign(script,parseScript(builtin),{code:builtin});
            if(script.name==='444叠加后处理.js'&&!script.resourceValues?.cardImage&&window.CustomStepBuiltinOverlay){
                script.resourceValues={...script.resourceValues,cardImage:clone(window.CustomStepBuiltinOverlay)};
            }
        }
        // 升级此前由程序生成的 444 属性卡替代脚本，保留用户选择的图片资源。
        for(const steps of Object.values(config))if(Array.isArray(steps))for(const step of steps){
            if(String(step.key)!=='444'||!Array.isArray(step.postprocess))continue;
            for(const script of step.postprocess){
                if(script.name==='444叠加后处理.js'&&String(script.code||'').includes('[444叠加] 已用当前产品行生成属性卡')){
                    const replacement=window.CustomStepBuiltinScripts?.['444叠加后处理.js'];
                    if(replacement)Object.assign(script,parseScript(replacement),{code:replacement});
                }
            }
            const expand=step.postprocess.findIndex(s=>s.name==='444扩图.js');
            const overlay=step.postprocess.findIndex(s=>s.name==='444叠加后处理.js');
            if(expand>=0&&overlay>=0&&overlay<expand){
                const [script]=step.postprocess.splice(overlay,1);
                step.postprocess.splice(step.postprocess.findIndex(s=>s.name==='444扩图.js')+1,0,script);
            }
        }
        return config;
    }
    function defaults() {return clone(window.CustomStepDefaults || []);}
    function validate(steps) {
        const keys = new Set(),errors=[];
        if (!steps.length) errors.push('请至少添加一个步骤');
        steps.forEach((step,i)=>{
            if (!step.name.trim()) errors.push(`步骤${i+1}：请填写图片名称`);
            if (!/^[\w\u4e00-\u9fff-]+$/.test(step.key)) errors.push(`步骤${i+1}：输出编号只能包含文字、数字、下划线或短横线`);
            if (keys.has(step.key)) errors.push(`步骤${i+1}：输出编号重复`);
            keys.add(step.key);
            if(step.imageSource!==undefined&&step.imageSource!=='product'&&step.imageSource!=='generated')errors.push(`步骤${i+1}：图片来源只能是 product 或 generated`);
            if(imageSourceOf(step)==='generated'&&!String(step.prompt||'').trim())errors.push(`步骤${i+1}：AI 生成步骤需要提示词`);
            for(const m of customMappings(step))if(String(step.prompt||'').includes('{'+m.variable+'}')&&!m.field)errors.push(`步骤${i+1}：请为「${m.label||m.variable}」选择 Excel 列`);
        });
        return errors;
    }
    function categoryOf(product) {
        const raw=String(product?._categoryType || product?.category || '').toLowerCase();
        if(raw.includes('non-hood')||raw.includes('sweatshirt')&&!raw.includes('hood'))return 'sweatshirt';
        if(raw.includes('hood'))return 'hoodie';
        if(raw.includes('t-shirt')||raw==='tshirt')return 'tshirt';
        if(raw.includes('shirt'))return 'shirt';
        return 'polo';
    }
    // 变量映射的字段候选 = 当前类目的【真实 Excel 列名】（与后处理 ctx.data.cell 同一真源）。
    // 不再列出界面 *_en/_cn 字段，避免提示词与后处理各读一套产品数据。
    function currentCanonical() { return state.canonical || canonicalOf(state.category); }
    function fieldOptions(selected) {
        let cols = [];
        try { cols = Array.from(window.CategoryFieldRules.columnsOf(currentCanonical())); } catch (e) { cols = []; }
        if (selected && !cols.includes(selected)) cols.push(selected);
        return '<option value="">选择当前产品行字段</option>' + cols.map(c => `<option value="${escape(c)}" ${c === selected ? 'selected' : ''}>${escape(c)}</option>`).join('');
    }
    function customMappings(step) { return (step.mappings||[]).filter(m=>m.custom===true); }
    function promptMarkup(step) {
        const labels=Object.fromEntries(customMappings(step).map(m=>[m.variable,m.label||m.variable]));
        const text=String(step.prompt||'');let result='',last=0;
        for(const match of text.matchAll(/\{([A-Za-z_]\w*)\}/g)){
            result+=escape(text.slice(last,match.index));
            result+=`<span class="step-prompt-token" contenteditable="false" data-map-token="${escape(match[1])}">{${escape(labels[match[1]]||match[1])}}</span>`;
            last=match.index+match[0].length;
        }
        return result+escape(text.slice(last));
    }
    function editorText(root) {
        let text='';
        function walk(node){
            if(node.nodeType===3){text+=node.nodeValue;return;}
            if(node.nodeType!==1&&node.nodeType!==11)return;
            if(node.nodeType===1&&node.dataset?.mapToken){text+='{'+node.dataset.mapToken+'}';return;}
            if(node.nodeName==='BR'){text+='\n';return;}
            if(/^(DIV|P)$/.test(node.nodeName)&&text&&!text.endsWith('\n'))text+='\n';
            for(const child of node.childNodes)walk(child);
        }
        for(const child of root.childNodes)walk(child);
        return text.replace(/\u00a0/g,' ');
    }
    function mappingRows(step) {
        const fixed=Object.entries(window.CategoryFieldRules.promptBindings(currentCanonical())).filter(([name])=>String(step.prompt||'').includes('{'+name+'}'));
        const names=new Set(fixed.map(([name])=>name));
        return fixed.map(([name,column])=>{
            const override=customMappings(step).find(m=>m.variable===name);
            return `<div class="step-mapping-row"><code>${escape(name)}</code><span>→</span><select data-default-column="${escape(name)}" aria-label="${escape(name)}对应的Excel列">${fieldOptions(override?override.field:column)}</select>${override?`<button type="button" data-action="reset-mapping" data-variable="${escape(name)}">恢复默认</button>`:''}</div>`;
        }).join('')+customMappings(step).filter(m=>!names.has(m.variable)).map(m=>`<div class="step-mapping-row"><code class="step-mapping-label">${escape(m.label||m.variable)}</code><span>→</span><select data-map-column="${escape(m.variable)}" aria-label="${escape(m.label||m.variable)}对应的Excel列">${fieldOptions(m.field)}</select><button type="button" data-action="remove-mapping" data-variable="${escape(m.variable)}" aria-label="删除映射">×</button></div>`).join('');
    }
    function capturePromptSelection() {
        if(!state)return;
        const selection=window.getSelection();let chosen=null;
        if(selection?.rangeCount&&!selection.isCollapsed){
            const range=selection.getRangeAt(0),node=range.commonAncestorContainer;
            const editor=(node.nodeType===1?node:node.parentElement)?.closest('.step-prompt-editor');
            if(editor&&state.view.contains(editor)&&range.toString().trim()&&![...editor.querySelectorAll('[data-map-token]')].some(token=>range.intersectsNode(token))){
                chosen={editor,range:range.cloneRange(),label:range.toString()};
            }
        }
        state.selection=chosen;
        state.view.querySelectorAll('.step-prompt-add').forEach(button=>{button.hidden=!chosen||!button.closest('.step-card').contains(chosen.editor);});
    }
    function addPromptMapping(step) {
        const selected=state.selection;if(!selected||!selected.editor.isConnected)return;
        const used=new Set([...String(step.prompt||'').matchAll(/\{([A-Za-z_]\w*)\}/g)].map(m=>m[1]));
        for(const m of step.mappings||[])used.add(m.variable);
        let index=1;while(used.has('map_'+index))index++;
        const variable='map_'+index,label=selected.label;
        step.mappings=step.mappings||[];step.mappings.push({variable,label,field:'',custom:true});
        const token=document.createElement('span');token.className='step-prompt-token';token.contentEditable='false';token.dataset.mapToken=variable;token.textContent='{'+label+'}';
        selected.range.deleteContents();selected.range.insertNode(token);
        step.prompt=editorText(selected.editor);state.selection=null;state.dirty=true;renderList();
        state.view.querySelector(`[data-map-column="${variable}"]`)?.focus();
        message('已添加映射，请选择该文字对应的 Excel 列；保存后生效。');
    }
    function sourceLabel(source) {
        if (source === 'currentSet.row') return '自动读取：当前导入 Excel 的当前产品行';
        if (source === 'currentSet.data') return '自动读取：当前产品行（旧 TXT 目录来源，已弃用）';
        if (source === 'currentSet.images') return '自动读取：当前套装图片';
        return '需选择文件：由你在界面选择';
    }
    // 读脚本源码里的 @resource / @contract 声明，得到该脚本「所需要的内容」
    function parseScript(code) {
        const text = String(code || '');
        let resources = [], contract = null, error = '';
        try { resources = window.parseResourceDeclarations ? window.parseResourceDeclarations(text) : []; }
        catch (e) { error = e.message; }
        try { contract = window.ScriptContractParser ? window.ScriptContractParser.parseScriptContract(text) : null; }
        catch (e) { if (!error) error = e.message; }
        return { resources, contract, error };
    }
    function scriptResources(script, scriptIndex) {
        const api=script.options?.apiConfig||{};
        const needsApi=/@needs\s+api:deepseek\b/.test(script.code||'')||String(script.code||'').includes('aiSimplifyTitle')||script.name==='111卖点图后处理.js';
        const apiFields=needsApi?`<div class="step-resource-row" style="flex-wrap:wrap"><span>AI 标题精简 API</span><label>接口地址<input type="url" placeholder="留空使用现有配置" value="${escape(api.url||'')}" data-api-script="${scriptIndex}" data-api-field="url"></label><label>模型<input placeholder="deepseek-chat" value="${escape(api.model||'')}" data-api-script="${scriptIndex}" data-api-field="model"></label><label>API Key<input type="password" autocomplete="off" placeholder="留空使用现有配置" value="${escape(api.apiKey||'')}" data-api-script="${scriptIndex}" data-api-field="apiKey"></label></div>`:'';
        let req;
        try { req = window.ScriptContractParser.requirements(script.code, currentCanonical()); }
        catch(e) { return `<div class="step-resource-note step-script-missing">${escape(e.message)}</div>`; }
        const fields = req.columns.map(column => {
            let value = '导入对应类目 Excel 后自动读取';
            try { if(state.snapshot && state.snapshot.category() === currentCanonical()) value = state.snapshot.cell(column) || '本行为空'; }
            catch(e) { value = e.message; }
            return `<div class="step-resource-row"><code>${escape(column)}</code><span>← 当前产品行</span><em>${escape(value)}</em></div>`;
        }).join('');
        const resources = req.resources.filter(r=>r.type!=='row').map(r => {
            const selected = script.resourceValues?.[r.key];
            const note=r.optional?'可选文件：未选择时由脚本自动处理':r.source==='currentSet.images'?'当前产品图片':'选择所需文件';
            return `<div class="step-resource-row"><span>📁 ${escape(r.label)}</span><span>${note}</span><label class="step-resource-picker">选择${r.type==='folder'?'文件夹':'文件'}<input type="file" data-resource-script="${scriptIndex}" data-resource-key="${escape(r.key)}" ${r.type==='folder'?'webkitdirectory multiple':''}></label><span>${escape(selected?.name || (r.optional?'未选择（可选）':'尚未选择'))}</span></div>`;
        }).join('');
        return `<div class="step-resource-list">${fields}${resources}${apiFields}${!fields&&!resources&&!apiFields?'<div class="step-resource-note">无需配置</div>':''}</div>`;
    }
    function card(step,index) {
        const expanded=state.expanded.has(step);
        return `<section class="step-card" data-index="${index}">
            <div class="step-card-top">
                <button type="button" class="step-toggle" data-action="toggle" aria-expanded="${expanded}" aria-controls="step-body-${index}" draggable="true" title="点击展开；拖动调整顺序">⋮⋮ 步骤${index+1}</button>
                <input class="step-name" data-field="name" value="${escape(step.name)}" aria-label="步骤${index+1}图片名称">
                <label>输出编号<input class="step-key" data-field="key" value="${escape(step.key)}" aria-label="步骤${index+1}输出编号"></label>
                <button type="button" class="step-test" data-action="test" title="仅预览：用当前产品行渲染提示词并列出脚本所需内容，不执行上传/生图/后处理">预览</button>
                <button type="button" class="step-test" data-action="execute" title="执行当前草稿步骤，成功保存后替换当前产品对应图片">测试</button>
                <button type="button" class="step-delete" data-action="delete">删除</button>
            </div>
            <div class="step-card-body" id="step-body-${index}" ${expanded?'':'hidden'}>
                <div class="step-section" data-ai-only ${imageSourceOf(step)==='generated'?'':'hidden'}><div class="step-section-title">📎 上传图片</div>
                    <select data-field="upload" aria-label="参考图来源"><option value="original" ${step.upload==='original'?'selected':''}>当前产品原图</option><option value="none" ${step.upload==='none'?'selected':''}>不上传图片</option></select>
                    <p class="step-config-note">原图统一来自扩展中配置的“产品原图目录”，对应当前产品行，不另设路径。</p>
                </div>
                <div class="step-section"><div class="step-section-title">图片来源</div>
                    <select data-field="imageSource" aria-label="图片来源">
                        <option value="product" ${imageSourceOf(step)==='product'?'selected':''}>直接使用产品主图</option>
                        <option value="generated" ${imageSourceOf(step)==='generated'?'selected':''}>AI 生成新图</option>
                    </select>
                    <p class="step-config-note">product = 读取产品主图，跳过 AI 生成，直接后处理；generated = 上传原图 + AI 生成新图，生成结果后再后处理。</p>
                </div>
                <div class="step-section"><div class="step-section-title"><span>后处理</span><button data-action="script">＋ 添加JS</button></div>
                    ${step.postprocess.map((script,j)=>`<div class="step-post-item"><div class="step-post-row"><span>${escape(script.name)}</span><button class="step-delete" data-action="remove-script" data-sub="${j}" aria-label="删除脚本">×</button></div>${String(script.code||'').trim()?'':`<div class="step-resource-list"><div class="step-resource-note step-script-missing">⚠️ 已配置后处理，但脚本内容为空：执行时会明确报错并停止，请点上方「＋ 添加JS」从脚本目录导入</div></div>`}${scriptResources(script,j)}</div>`).join('')||'<div class="step-config-note">未配置后处理（执行时直接用原图）</div>'}
                    <p class="step-config-note">脚本所需字段自动取当前产品行；额外文件在对应脚本下选择，随步骤配置保存。</p>
                </div>
                <div class="step-section" data-ai-only ${imageSourceOf(step)==='generated'?'':'hidden'}><div class="step-section-title"><span>🔗 字段映射 · 当前类目 Excel 列</span></div>
                    ${mappingRows(step)}
                </div>
                <div class="step-prompt-wrap" data-ai-only ${imageSourceOf(step)==='generated'?'':'hidden'}>
                    <div class="step-prompt-toolbar"><p class="step-config-note">选中文字后添加映射；高亮文字读取当前产品行所选列的英文。[[...]] 内属性为空时整段省略。</p><button type="button" class="step-prompt-add" data-action="add-mapping" hidden>＋ 添加映射</button></div>
                    <div class="step-prompt-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="步骤${index+1}提示词" data-field="prompt" spellcheck="false">${promptMarkup(step)}</div>
                </div>
            </div>
        </section>`;
    }
    function message(text) {if(state)state.view.querySelector('.step-config-message').textContent=text;}
    function renderList() {state.selection=null;state.view.querySelector('.step-config-list').innerHTML=state.steps.map(card).join('');}
    // 提示词渲染（提示词与后处理共用的唯一实现）：变量值来自【当前产品行快照】的真实 Excel 列，
    // 与后处理 ctx.data.cell 读的是同一份快照、同一套列名。列不存在时 snapshot.cell 抛错（配置错误）。
    // [[...]] 中变量为空 → 整段省略；仍有未解析 {变量} 时如实返回 missing。
    function renderPrompt(step, snapshot) {
        if (!snapshot || typeof snapshot.cell !== 'function') throw new Error('缺少当前产品行快照，无法渲染提示词');
        const values = {}, missing = [];
        const bindings = {...window.CategoryFieldRules.promptBindings(snapshot.category())};
        const allowed=new Set(window.CategoryFieldRules.columnsOf(snapshot.category()));
        for(const mapping of customMappings(step)){
            if(!/^[A-Za-z_]\w*$/.test(mapping.variable))throw new Error('映射变量名无效');
            if(!String(step.prompt||'').includes('{'+mapping.variable+'}'))continue;
            if(!mapping.field){missing.push(mapping.variable);continue;}
            if(!allowed.has(mapping.field))throw new Error('当前类目没有映射列「'+mapping.field+'」，请重新选择');
            bindings[mapping.variable]=mapping.field;
        }
        for (const match of String(step.prompt || '').matchAll(/\{([A-Za-z_]\w*)\}/g)) {
            const name = match[1];
            if (!Object.prototype.hasOwnProperty.call(bindings, name)) { if (!missing.includes(name)) missing.push(name); continue; }
            values[name] = bindings[name] ? window.ExcelRow.englishText(snapshot.cell(bindings[name])) : '';
        }
        let text = String(step.prompt || '').replace(/\[\[([\s\S]*?)\]\]/g, (all, body) => {
            const vars = [...body.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(m => m[1]);
            return vars.some(name => !values[name]) ? '' : body;
        });
        text = text.replace(/\{([A-Za-z_]\w*)\}/g, (all, name) => {
            if (!values[name]) { if (!missing.includes(name)) missing.push(name); return all; }
            return values[name];
        });
        return { text, missing };
    }
    // 预览文案（纯函数，便于测试）：预览永远基于【当前草稿】，执行永远基于【任务启动时冻结的已保存配置】。
    const PREVIEW_NOTE = '预览包含未保存修改；实际执行使用任务启动时冻结的已保存配置。';
    const PREVIEW_SCOPE = '本次仅预览当前产品行的提示词与脚本所需内容，不触发上传、生图或后处理，不代表已通过实际执行测试。';
    // 脚本所需内容清单：脚本内容为空（默认占位脚本）必须单独、明确地列出来，不混进「无资源声明」
    function postprocessLines(step) {
        return ((step && step.postprocess) || []).map(script => {
            if (!String(script.code || '').trim()) return `· ${script.name}：尚未导入脚本内容（已配置后处理但脚本为空，执行时会明确报错，请先导入）`;
            if (script.error) return `· ${script.name}：声明解析失败（${script.error}）`;
            const decl = script.resources || [];
            if (!decl.length) return `· ${script.name}：无资源声明`;
            const table = decl.filter(item => item.source === 'currentSet.row' || item.source === 'currentSet.data').length;
            const images = decl.filter(item => item.source === 'currentSet.images').length;
            const user = decl.filter(item => item.source === 'user').length;
            const parts = [];
            if (table) parts.push(`表格当前行 ${table}`);
            if (images) parts.push(`套装图片 ${images}`);
            if (user) parts.push(`需选择 ${user}`);
            return `· ${script.name}：${decl.length} 项所需内容（${parts.join('，')}）`;
        });
    }
    function previewText(index, step, snapshotDesc, result, errorMessage) {
        const head = `步骤${index + 1} · ${step.name}${snapshotDesc ? `（数据来源：${snapshotDesc}）` : ''}`;
        if (errorMessage) return `${head}\n预览失败：${errorMessage}\n\n${PREVIEW_NOTE}\n${PREVIEW_SCOPE}`;
        const lines = postprocessLines(step);
        return `${head}\n${result.missing.length ? '未映射变量：' + result.missing.join('、') + '\n' : ''}${result.text}${lines.length ? '\n\n所需内容：\n' + lines.join('\n') : ''}\n\n${PREVIEW_NOTE}\n${PREVIEW_SCOPE}`;
    }
    const preview = renderPrompt;

    // 任务步骤唯一真源：按产品行类目取面板保存的步骤（未保存则用默认五步）。
    function stepsForCategory(canonical) {
        const uiKey = uiKeyOf(canonical);
        if (!uiKey) throw new Error('未知类目：' + canonical + '，无法取步骤配置');
        const all = read();
        return clone(all[uiKey] || defaults());
    }
    async function requestScripts(payload) {
        let timer;
        try {
            const result=await Promise.race([
                psDirectoryMessage(payload),
                new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('扩展未响应，请重新加载扩展后重试')),10000);})
            ]);
            if(!result?.ok) {
                if(/未知消息动作|unknown.*action/i.test(result?.error||'')) {
                    throw new Error('扩展仍是旧版：请在 chrome://extensions 中找到Polo发品助手，点击重新加载，再刷新助手页面。仅刷新助手不会更新扩展。');
                }
                throw new Error(result?.error || '扩展未返回脚本目录');
            }
            return result;
        } finally {clearTimeout(timer);}
    }
    function close() {
        if(!state)return;
        const old=state;document.removeEventListener('selectionchange',capturePromptSelection);state=null;
        old.panel.classList.remove('step-config-mode');
        old.panel.replaceChildren(old.original);
        old.panel.scrollTop=old.scroll;window.UiPolish?.settleDetail(old.panel);
        if(currentProduct!==old.product||old.testUpdated)renderDetail();
    }
    function open() {
        if(state||!currentProduct)return;
        try {
            const all=read(),panel=document.getElementById('detailPanel');
            // 类目与产品行同一真源：优先用「当前导入 Excel 的当前产品行」快照解析类目（与后处理一致）；
            // 快照不可用（未导入 Excel / 该行不可用）时退回界面提示，预览会明确说明取不到真实字段值。
            let snapshot=null,canonical='',category='';
            try{ snapshot=window.buildExcelRowSnapshot(currentProduct.row);canonical=snapshot.category();category=uiKeyOf(canonical); }
            catch(e){ snapshot=null;category=categoryOf(currentProduct); }
            const original=document.createDocumentFragment();
            while(panel.firstChild)original.appendChild(panel.firstChild);
            state={panel,original,scroll:panel.scrollTop,product:currentProduct,all,snapshot,canonical,category,steps:clone(all[category]||defaults()),expanded:new Set(),dirty:false,drag:null};
            const view=document.createElement('div');state.view=view;view.className='step-config-view';
            view.innerHTML=`<header class="step-config-heading"><h2>⚙️ 自定义步骤配置</h2><button class="step-close" data-command="close" aria-label="退出自定义步骤配置">×</button></header>
                <div class="step-config-toolbar"><p>拖拽步骤编号排序，点击编号展开内容；按类目分别配置。</p><label>类目 <select id="custom-step-category">${categories.map(([key,label])=>`<option value="${key}" ${key===category?'selected':''}>${label}</option>`).join('')}</select></label><button class="primary" data-command="add">＋ 添加步骤</button><button data-command="reset">↺ 恢复默认</button></div>
                <div class="step-config-list"></div><div class="step-config-message" role="status"></div><footer class="step-config-footer"><button data-command="close">取消</button><button class="primary" data-command="save">保存</button></footer>`;
            panel.classList.add('step-config-mode');panel.appendChild(view);renderList();window.UiPolish?.enter(view);
            document.addEventListener('selectionchange',capturePromptSelection);
            view.addEventListener('mouseup',capturePromptSelection);view.addEventListener('keyup',capturePromptSelection);
            view.addEventListener('mousedown',event=>{if(event.target.closest('.step-prompt-add'))event.preventDefault();});
            view.addEventListener('paste',event=>{
                const editor=event.target.closest('.step-prompt-editor');if(!editor)return;
                event.preventDefault();const selection=window.getSelection();if(!selection?.rangeCount)return;
                const range=selection.getRangeAt(0);if(!editor.contains(range.commonAncestorContainer))return;
                range.deleteContents();const text=document.createTextNode(event.clipboardData.getData('text/plain'));range.insertNode(text);range.setStartAfter(text);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
                editor.dispatchEvent(new Event('input',{bubbles:true}));
            });
            view.addEventListener('input',edit);view.addEventListener('change',edit);view.addEventListener('click',click);
            view.addEventListener('dragstart',event=>{const handle=event.target.closest('.step-toggle');if(!handle)return;state.drag=Number(handle.closest('.step-card').dataset.index);event.dataTransfer.setData('text/plain',String(state.drag));event.dataTransfer.effectAllowed='move';});
            view.addEventListener('dragover',event=>{if(event.target.closest('.step-card'))event.preventDefault();});
            view.addEventListener('drop',event=>{if(event.target.closest('.step-prompt-editor')){event.preventDefault();return;}const target=event.target.closest('.step-card');if(!target||state.drag===null)return;event.preventDefault();const [step]=state.steps.splice(state.drag,1);state.steps.splice(Number(target.dataset.index),0,step);state.drag=null;state.dirty=true;renderList();});
            view.addEventListener('dragend',()=>{if(state)state.drag=null;});
        } catch(error) {if(state)close();showToast('打开配置失败：'+error.message);}
    }
    async function edit(event) {
        if(event.target.dataset.apiField){const card=event.target.closest('.step-card');const script=state.steps[Number(card.dataset.index)].postprocess[Number(event.target.dataset.apiScript)];script.options=script.options||{};script.options.apiConfig=script.options.apiConfig||{};script.options.apiConfig[event.target.dataset.apiField]=event.target.value.trim();state.dirty=true;return;}
        if(event.target.dataset.resourceKey) {
            if(event.type!=='change')return;
            const input=event.target, owner=state;
            const card=input.closest('.step-card'), step=state.steps[Number(card.dataset.index)];
            const script=step.postprocess[Number(input.dataset.resourceScript)], key=input.dataset.resourceKey;
            owner.resourceLoads=(owner.resourceLoads||0)+1;
            owner.view.querySelector('[data-command="save"]').disabled=true;
            try {
                const files=Array.from(input.files||[]); if(!files.length)return;
                const values=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{
                    const reader=new FileReader();reader.onerror=()=>reject(new Error('文件读取失败'));
                    reader.onload=()=>resolve({name:file.webkitRelativePath||file.name,dataUrl:reader.result});reader.readAsDataURL(file);
                })));
                if(state!==owner)return;
                script.resourceValues=script.resourceValues||{};
                const ref=crypto.randomUUID();
                const value=input.multiple?Object.fromEntries(values.map(v=>[v.name,v.dataUrl])):values[0].dataUrl;
                await SuiteCore.ResultStore('polo_script_resources').put({fileKey:'resources',rowNum:0,key:ref,meta:{value}});
                if(state!==owner)return;
                script.resourceValues[key]={name:values.length===1?files[0].name:files.length+'个文件',ref};
                state.dirty=true;renderList();message('资源已读取，保存步骤后生效');
            }catch(e){message(e.message);}
            finally {owner.resourceLoads--;if(state===owner)owner.view.querySelector('[data-command="save"]').disabled=owner.resourceLoads>0;}
            return;
        }
        if(event.target.id==='custom-step-category'){
            if(state.dirty&&!confirm('当前类目有未保存修改，切换将放弃这些修改。继续？')){event.target.value=state.category;return;}
            state.category=event.target.value;state.canonical=canonicalOf(state.category);state.steps=clone(state.all[state.category]||defaults());state.expanded.clear();state.dirty=false;renderList();message('');return;
        }
        const card=event.target.closest('.step-card');if(!card)return;
        const step=state.steps[Number(card.dataset.index)],field=event.target.dataset.field;
        if(event.target.dataset.defaultColumn){
            const variable=event.target.dataset.defaultColumn;
            step.mappings=step.mappings||[];
            let mapping=step.mappings.find(m=>m.variable===variable);
            if(!mapping){mapping={variable,label:variable};step.mappings.push(mapping);}
            Object.assign(mapping,{field:event.target.value,custom:true});state.dirty=true;renderList();return;
        }
        if(event.target.dataset.mapColumn){
            const mapping=customMappings(step).find(m=>m.variable===event.target.dataset.mapColumn);
            if(mapping)mapping.field=event.target.value;state.dirty=true;return;
        }
        if(!field)return;
        if(field==='imageSource'){
            // 切换来源只改显示：提示词、参考图、映射等已保存内容原样保留，不因隐藏而丢失。
            step.imageSource=event.target.value==='product'?'product':'generated';
            state.dirty=true;renderList();return;
        }
        if(field==='prompt'&&event.target.classList.contains('step-prompt-editor'))step.prompt=editorText(event.target);
        else step[field]=event.target.value;
        state.dirty=true;
    }
    async function click(event) {
        const button=event.target.closest('button');if(!button)return;
        const command=button.dataset.command;
        if(command==='close'){if(!state.dirty||confirm('放弃未保存的配置修改？'))close();return;}
        if(command==='add'){state.steps.push({name:'新步骤',key:'',prompt:'',upload:'original',postprocess:[],mappings:[]});state.dirty=true;renderList();return;}
        if(command==='reset'){if(confirm('恢复当前类目的默认五个步骤？保存前不会覆盖已有配置。')){state.steps=defaults();state.expanded.clear();state.dirty=true;renderList();}return;}
        if(command==='save'){
            const errors=validate(state.steps);if(errors.length){message(errors.join('\n'));return;}
            try{const latest=read();latest[state.category]=clone(state.steps);localStorage.setItem(STORAGE,JSON.stringify(latest));state.all=latest;state.dirty=false;showToast('自定义步骤配置已保存');close();}catch(error){message('保存失败：'+error.message);}return;
        }
        const node=button.closest('.step-card');if(!node)return;
        const index=Number(node.dataset.index),step=state.steps[index],action=button.dataset.action;
        if(action==='execute'){
            if(state.testing)return;
            if(typeof suiteTaskRunning!=='undefined'&&suiteTaskRunning||typeof suiteBatchRunning!=='undefined'&&suiteBatchRunning||typeof targetedRegenerationRunning!=='undefined'&&targetedRegenerationRunning||typeof batchColorState!=='undefined'&&batchColorState?.running){message('请先暂停当前生成任务，再测试此步骤');return;}
            if(!state.snapshot||state.product!==currentProduct){message('请先导入 Excel 并选择当前产品');return;}
            const errors=validate([step]);if(errors.length){message(errors.join('\n'));return;}
            if(state.resourceLoads){message('文件资源正在读取，请稍后测试');return;}
            const owner=state,key=String(step.key),fileKey=currentFileKey(),rowNum=currentProduct.row;
            owner.testing=true;button.disabled=true;
            message(`正在测试：${step.name}（${key}），成功后替换对应图片…`);
            try{
                const previous=readSuiteAutoState();
                if(previous&&previous.phase!=='completed')throw Error('存在未完成套图任务，请先通过顶部进度继续完成');
                await runSuiteFiveJob({keys:[key],stepsOverride:clone(owner.steps)});
                const result=readSuiteAutoState();
                if(!result||result===previous||result.jobId===previous?.jobId||result.fileKey!==fileKey||result.rowNum!==rowNum||result.phase!=='completed')throw Error('测试未完成，请查看任务进度或错误提示；原图片未标记为测试成功');
                owner.testUpdated=true;
                if(state===owner){message(`测试成功：${key} ${step.name}，对应图片已替换并保存。`);}else if(currentFileKey()===fileKey&&currentProduct?.row===rowNum){renderDetail();}
            }catch(error){if(state===owner)message('测试失败：'+error.message);}
            finally{owner.testing=false;if(button.isConnected)button.disabled=false;}
            return;
        }
        if(action==='add-mapping'){addPromptMapping(step);return;}
        if(action==='reset-mapping'){
            step.mappings=(step.mappings||[]).filter(m=>!(m.variable===button.dataset.variable&&m.custom===true));
            state.dirty=true;renderList();return;
        }
        if(action==='remove-mapping'){
            const variable=button.dataset.variable,mapping=customMappings(step).find(m=>m.variable===variable);
            if(mapping){step.prompt=String(step.prompt||'').split('{'+variable+'}').join(mapping.label||variable);step.mappings=step.mappings.filter(m=>m!==mapping);}
            state.dirty=true;renderList();return;
        }
        if(action==='toggle'){const expanded=!state.expanded.has(step);expanded?state.expanded.add(step):state.expanded.delete(step);button.setAttribute('aria-expanded',String(expanded));const body=node.querySelector('.step-card-body');if(window.UiPolish)window.UiPolish.toggleDisclosure(body,expanded);else body.hidden=!expanded;return;}
        if(action==='test'){
            if(!state.snapshot){message(`步骤${index+1} · ${step.name}\n无法预览：当前产品没有可用的 Excel 行快照（未导入 Excel 或该行不可用）。\n\n${PREVIEW_NOTE}\n${PREVIEW_SCOPE}`);return;}
            let result;
            try{ result=renderPrompt(step,state.snapshot); }
            catch(error){ message(previewText(index,step,'',null,error.message));return; }
            message(previewText(index,step,state.snapshot.describe(),result));
            return;
        }
        if(action==='delete'){if(confirm('删除这个步骤？')){state.steps.splice(index,1);state.expanded.delete(step);}else return;}
        if(action==='remove-script')step.postprocess.splice(Number(button.dataset.sub),1);
        if(action==='script'){
            const owner=state;
            const section=button.closest('.step-section');
            button.disabled=true;
            section.querySelector('.step-script-chooser')?.remove();
            const progress=document.createElement('div');progress.className='step-script-chooser';progress.setAttribute('role','status');progress.textContent='正在读取已配置的JS脚本目录…';section.appendChild(progress);
            try {
                const result=await requestScripts({action:'listScriptDirectory'});
                if(state!==owner||!state.steps.includes(step))return;
                if(!result.ok)throw new Error(result.error);
                section.querySelector('.step-script-chooser')?.remove();
                const chooser=document.createElement('div');chooser.className='step-script-chooser';
                chooser.dataset.revision=result.revision;
                chooser.innerHTML=`<div class="step-config-note">📁 ${escape(result.name)}${result.cached?' · 已保存的脚本快照（更新本地脚本后在扩展中点保存同步）':''}</div>
                    <div class="step-script-files">${result.files.map(file=>`<label><input type="checkbox" value="${escape(file.path)}"> <span>${escape(file.path)}</span></label>`).join('')||'<div class="step-config-note">此目录中没有JS脚本</div>'}</div>
                    <div class="step-script-actions"><button data-action="cancel-script">取消</button><button class="primary" data-action="confirm-script">添加所选脚本</button></div>`;
                section.appendChild(chooser);
            } catch(error){if(state===owner){progress.textContent='打开JS脚本目录失败：'+error.message;message('打开JS脚本目录失败：'+error.message);showToast(error.message);}}
            finally {button.disabled=false;}
            return;
        }
        if(action==='cancel-script'){button.closest('.step-script-chooser').remove();return;}
        if(action==='confirm-script'){
            const chooser=button.closest('.step-script-chooser'),owner=state;
            const paths=Array.from(chooser.querySelectorAll('input:checked'),input=>input.value);
            if(!paths.length){message('请先选择JS脚本');return;}
            button.disabled=true;
            try{
                const result=await requestScripts({action:'readScriptDirectory',paths,revision:chooser.dataset.revision});
                if(state!==owner||!state.steps.includes(step))return;
                if(!result.ok)throw new Error(result.error);
                for(const script of result.scripts){
                    const item=Object.assign({},script,parseScript(script.code));
                    const existing=step.postprocess.findIndex(entry=>entry.path===item.path||(!entry.code&&entry.name===item.name));
                    if(existing>=0)step.postprocess[existing]=item;else step.postprocess.push(item);
                }
                state.dirty=true;renderList();message('已从配置的JS脚本目录添加脚本，保存步骤后生效');
            }catch(error){if(state===owner)message('读取脚本失败：'+error.message);}
            finally {button.disabled=false;}
            return;
        }
        state.dirty=true;renderList();
    }
    // 编辑期间阻止左侧选品覆盖草稿；保存或退出后恢复原操作，不写产品或Excel。
    document.addEventListener('click',event=>{if(state&&event.target.closest('.product-card')){event.preventDefault();event.stopImmediatePropagation();showToast('请先保存或退出步骤配置');}},true);
    window.CustomStepConfig={open,close,validate,preview,renderPrompt,previewText,postprocessLines,PREVIEW_NOTE,stepsForCategory,uiKeyOf,canonicalOf,requestScripts,promptMarkup,editorText,imageSourceOf,defaultImageSource,isOpen:()=>!!state};
})();
