/* 手动复核试验：只修复当前表单，不保存、不推进队列。未知结构不能判通过。 */
(() => {
    'use strict';
    const norm = x => String(x ?? '').replace(/\s+/g, '').toLowerCase();
    const rendered = e => !!e && e.isConnected !== false && (!e.getBoundingClientRect || e.getBoundingClientRect().height > 0);
    const result = (ok, detail) => ({ state: ok === null ? 'unknown' : ok ? 'pass' : 'fail', detail });
    function expectedParts(value) {
        const values = Array.isArray(value) ? value : String(value ?? '').split(/[,，;；\n]+/);
        return values.map(v => typeof pickEnglishPart === 'function' ? pickEnglishPart(String(v)) : String(v)).map(norm).filter(Boolean);
    }
    function score(doc) {
        const live = [...doc.querySelectorAll('.check-area')].find(e => e.getBoundingClientRect?.().height > 0 && e.textContent.includes('商品质量助手'));
        if (live) {
            const value = live.querySelector('.score-text')?.textContent.trim();
            return /^[0-5]\.\d$/.test(value || '') ? Number(value) : null;
        }
        const nodes = [...doc.querySelectorAll('div,section,aside')].filter(e =>
            !e.closest('#polo-helper-panel') && (e.textContent || '').includes('商品质量助手'));
        nodes.sort((a, b) => a.textContent.length - b.textContent.length);
        for (const e of nodes) {
            if (e.textContent.length > 400) continue;
            const m = e.textContent.match(/商品质量助手\s*([0-5]\.\d)(?!\d)/);
            if (m) return Number(m[1]);
        }
        return null;
    }
    async function run(items, repair, report, options = {}) {
        const rows = [];
        for (const item of items) {
            if(options.isCurrent && !options.isCurrent())throw Error('当前商品或页面已切换，停止检查');
            let before;
            try { if(item.prepare)await item.prepare(); before = await item.read(); } catch (e) { before = result(null, e.message); }
            if(options.isCurrent&&!options.isCurrent())throw Error('当前商品或页面已切换，停止检查');
            report(item.label, before);
            let after = before;
            if (before.state === 'fail' && item.repair !== false) {
                try {
                    // 判空与执行之间用户/页面可能补回值；第二次确认，禁止使用旧读数重填。
                    const current = await item.read();
                    if(options.isCurrent && !options.isCurrent())throw Error('当前商品或页面已切换，停止补填');
                    if(current.state !== 'fail') {
                        after=current; report(item.label,after);
                        rows.push({label:item.label,before,after}); continue;
                    }
                    report(item.label, result(null, '正在补填…'));
                    if (item.repair) await item.repair(options);
                    else await repair(item.action);
                    after = await item.read();
                } catch (e) { after = result(null, '补填异常：' + e.message); }
                report(item.label, after);
            }
            rows.push({ label: item.label, before, after });
        }
        return rows;
    }
    function qualityCard(doc) {
        const live = [...doc.querySelectorAll('.check-area')].find(e => e.getBoundingClientRect?.().height > 0 && e.textContent.includes('商品质量助手'));
        if (live) return live;
        return [...doc.querySelectorAll('div,section,aside')]
            .filter(e => !e.closest('#polo-helper-panel') && e.textContent.includes('商品质量助手') && e.textContent.length < 400 && (!e.getBoundingClientRect || e.getBoundingClientRect().height > 0))
            .sort((a,b) => a.textContent.length - b.textContent.length)
            .find(e => [...e.querySelectorAll('button,a,[role="button"],span,div')].some(b => /^(质量检测|重新检测)$/.test(b.textContent.trim())));
    }
    // 重新检测不能立即接受点击前的旧分数；必须观察检测中状态或分数改变。
    async function detectQuality(doc, click, options = {}) {
        const wait = options.wait || (ms => new Promise(r => setTimeout(r,ms)));
        const before = score(doc);
        const card = qualityCard(doc);
        const button = card && [...card.querySelectorAll('button,a,[role="button"],span,div')]
            .find(e => /^(质量检测|重新检测)$/.test(e.textContent.trim()) && e.getBoundingClientRect().height > 0);
        if (!button) throw Error('未找到商品质量助手的检测按钮，请手动检测后重试');
        let changed = before === null;
        const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
            if (score(doc) === null || /检测中|正在检测|检测进行中/.test(card.textContent)) changed = true;
        }) : null;
        observer?.observe(card,{subtree:true,childList:true,characterData:true,attributes:true});
        try {
            await click(button);
            for (let i=0;i<(options.attempts || 60);i++) {
                await wait(500);
                const current = score(doc), busy = /检测中|正在检测|检测进行中/.test(card.textContent);
                if (current === null || busy) changed = true;
                if (current !== null && !busy && (changed || current !== before)) return current;
            }
            throw Error('质量检测超时，未能确认新结果；不采用旧分数');
        } finally { observer?.disconnect(); }
    }
    function checks(product, doc = document) {
        const items = [
            {label: '6张主图', action: 'fill_images'},
            {label: '商品名称', action: 'fill_title'},
            {label: '商品分组', action: 'fill_group'},
            {label: '商品属性', action: 'fill_attributes'},
            {label: '颜色及规格图', action: 'fill_colors'},
            {label: '颜色规格图', action: 'review_color_images'},
            {label: '尺码', action: 'fill_sizes'},
            {label: '尺码表数字', action: 'fill_size_template'},
            {label: '计量单位', action: 'fill_price_unit'},
            {label: '起订量及阶梯价', action: 'fill_ladder_price'},
            {label: '颜色规格库存', action: 'fill_batch_qty'},
            {label: '发货期和物流信息', action: 'fill_logistics'},
            {label: '箱规关联', action: 'fill_box_rule'},
            {label: '细节图', action: 'fill_detail_images'},
            {label: '卖点文案', action: 'fill_highlights'},
            {label: '公司介绍内容', action: 'fill_company_intro_template'},
            {label: 'FAQ', action: 'fill_faqs'},
            {label: '定制服务模板', action: 'fill_logistics_template'},
        ];
        return items.map(entry => ({...entry, read: () => entry.action==='fill_batch_qty'&&window.PoloReviewStock?window.PoloReviewStock.scan(doc):presence(entry.action, doc, product),
            prepare: async () => {
                const target={fill_highlights:'#struct-textDesc',fill_faqs:'#struct-companyFaqDesc',fill_company_intro_template:'#struct-companyDesc',fill_logistics:'#struct-pkgWeight',fill_size_template:'.size-chart-table-main,.country-size-chart-container,.size-chart-qiankun'}[entry.action];
                const area=target&&doc.querySelector(target);
                if(area?.scrollIntoView){area.scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,600));}
            },
            ...(['fill_faqs','fill_logistics','fill_ladder_price'].includes(entry.action)?{repair:options=>repairEmptyFields(entry.action,doc,product,options)}:{}),
            ...(entry.action==='review_color_images'?{repair:async(options={})=>{
                if(!window.PoloReviewColors)throw Error('颜色图检查模块未加载');
                await window.PoloReviewColors.repair(doc,product,{
                    isCurrent:options.isCurrent,
                    read:async key=>{
                        if(!product._publishFileKey)throw Error('商品缺少文件身份，不读取颜色补图');
                        const source=await sendMessageRetry({action:'getColorImagePath',taskId:product._publishTaskId||getTaskFromUrl(),fileKey:product._publishFileKey,rowNum:product.row,color:key});
                        if(source?.fileKey!==product._publishFileKey||Number(source.rowNum)!==Number(product.row)||source.color!==key)throw Error('颜色图片来源与当前商品不一致，不上传');
                        return source;
                    },
                    upload:(target,url)=>uploadColorImageViaBlob(target.key,target.label,target.index,url,{missingOnly:true,expectedInput:target.input,isCurrent:options.isCurrent})
                });
            }}:{}),
            ...(entry.action==='fill_batch_qty'?{repair:async(options={})=>{
                if(!window.PoloReviewStock)throw Error('库存检查模块未加载');
                await window.PoloReviewStock.scan(doc,async input=>{
                    if(options.isCurrent&&!options.isCurrent())throw Error('商品已切换，停止库存补填');
                    if(String(input.value||'').trim())return;
                    await realClick(input);
                    if(options.isCurrent&&!options.isCurrent())throw Error('商品已切换，停止库存补填');
                    if(String(input.value||'').trim())return;
                    setInputValue(input,'10000');confirmInput(input);
                    if(typeof commitFieldByClick==='function')await commitFieldByClick(input,'库存空项');
                });
            }}:{}),
            ...(['fill_colors','fill_sizes','fill_size_template','fill_box_rule','fill_company_intro_template','fill_logistics_template'].includes(entry.action)?{repair:false}:{}),
            ...(['fill_images','fill_detail_images'].includes(entry.action)?{repair:async()=>{
                await requestPublicationUpload(product,entry.action==='fill_images'?'main':'detail',{appendOnly:true});
            }}:{}),
            ...(entry.action === 'fill_attributes' ? {repair: async (options={}) => {
                const fields=buildAttributeFields(product);
                for(const field of [...fields.required,...fields.optional].filter(f=>f.val!==''&&f.val!=null)) {
                    if(options.isCurrent&&!options.isCurrent())throw Error('商品已切换，停止属性补填');
                    const area=findFieldContainer('',field.lbl);
                    if(!rendered(area))continue;
                    const values=[...area.querySelectorAll('input:not([type="hidden"]),textarea,.next-tag-body,.next-select-values')].map(e=>String(e.value||e.textContent||'').trim()).filter(v=>!/^(请选择|请输入|please select)[\s.。…]*$/i.test(v));
                    if(values.length&&!values.some(Boolean))await fillAttributeField(field,product);
                }
            }} : {})
        }));
    }
    function logisticsFields(doc) {
        const fields=[
            [doc.querySelector('#struct-ladderPeriod input[role="input-quantity"],#ladderPeriod input[role="input-quantity"]'),'50','发货期数量'],
            [doc.querySelector('#struct-ladderPeriod input[role="input-day"],#ladderPeriod input[role="input-day"]'),'31','发货天数'],
            [doc.querySelector('input#pkgWeight,input[name="pkgWeight"]'),'0.48','毛重']
        ];
        const area=[...doc.querySelectorAll('.component-pkgMeasure')].find(e=>e.getBoundingClientRect().height>0);
        for(const [name,value] of [['长','50'],['宽','40'],['高','30']]) {
            const col=[...(area?.querySelectorAll('.next-col-8')||[])].find(e=>e.querySelector('.next-row:first-child')?.textContent.includes(name));
            fields.push([col?.querySelector('input'),value,name]);
        }
        return fields;
    }
    async function repairEmptyFields(action,doc,product,options={}) {
        let fields=[];
        if(action==='fill_logistics')fields=logisticsFields(doc);
        if(action==='fill_ladder_price') {
            const quantities=[...doc.querySelectorAll('input[role="input-quantity"]')].filter(e=>!e.closest('#struct-ladderPeriod,#ladderPeriod'));
            const prices=[...doc.querySelectorAll('input[role="input-price"]')];
            const base=Number(String(product.price||'').match(/[\d.]+/)?.[0]);
            [50,500,2000,5000].forEach((quantity,i)=>{
                if(quantities[i])fields.push([quantities[i],String(quantity),'起订量']);
                if(base>0&&prices[i]&&(!quantities[i]?.value.trim()||Number(quantities[i].value)===quantity))fields.push([prices[i],(Math.ceil(base*6.5)*.5/6.5/[.5,.7,.8,.9][i]).toFixed(2),'阶梯价']);
            });
        }
        if(action==='fill_faqs') {
            fields=faqMissing(doc,product).targets;
        }
        await writeEmptyTargets(fields,options);
        if(action==='fill_faqs'&&window.PoloReviewFaq)await window.PoloReviewFaq.appendMissing(doc,resolveFaqs(product,8).use,{click:realClick,write:targets=>writeEmptyTargets(targets,options),isCurrent:options.isCurrent});
    }
    async function writeEmptyTargets(fields,options={}) {
        for(const [initialInput,value,label,resolve] of fields) {
            let input=resolve?resolve():initialInput;
            if(options.isCurrent&&!options.isCurrent())throw Error('商品已切换，停止字段补填');
            if(!rendered(input)||!String(value||'').trim()||String(input.value||'').trim())continue;
            input.scrollIntoView({block:'center'});
            await realClick(input);
            if(options.isCurrent&&!options.isCurrent())throw Error('商品已切换，停止字段补填');
            if(resolve)input=resolve();
            if(!rendered(input))throw Error('字段已隐藏或重新渲染，停止使用旧控件');
            // 点击期间用户可能填入内容，再检查一次，禁止覆盖。
            if(String(input.value||'').trim())continue;
            if(label.includes('FAQ'))input.focus?.();
            setInputValue(input,String(value));
            if(label.includes('FAQ')) {
                // 与原FAQ填入一致：平台需要带文本的InputEvent及Enter提交。
                if(typeof InputEvent!=='undefined')input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(value)}));
                if(typeof pressEnter==='function')pressEnter(input);
            }
            confirmInput(input);
            // FAQ不在普通表单标签区，需真正离开输入框，等待平台提交后再新增下一行。
            if(label.includes('FAQ')) {
                input.blur?.();
                await new Promise(r=>setTimeout(r,350));
            }
            if(typeof commitFieldByClick==='function')await commitFieldByClick(input,label);
        }
    }
    function faqMissing(doc,product) {
        if(!window.PoloReviewFaq)throw Error('FAQ检查模块未加载，请重新加载扩展后再检查');
        return window.PoloReviewFaq.plan(doc,resolveFaqs(product,8).use);
    }
    // 缺项检查不比较默认值；部分填写的整组禁止调用覆盖式填入函数。
    function presence(action, doc, product) {
        const q = s => doc.querySelector(s), all = s => [...doc.querySelectorAll(s)];
        const value = e => String(e?.value || e?.textContent || '').trim();
        const single = selector => { const e=q(selector); return rendered(e) ? result(!!value(e), value(e) ? '已有内容，保留' : '空白，补填') : result(null,'控件未定位，不修改'); };
        const group = (values, expected, name) => {
            const filled=values.filter(v=>String(v??'').trim());
            if (!values.length) return result(null,name+'区域未定位，不修改');
            if (!filled.length) return result(false,name+'全部为空');
            return result(filled.length >= expected ? true : null,filled.length >= expected ? name+'已有内容，保留' : name+'部分缺失，保留已有内容；需逐项补填，禁止整组覆盖');
        };
        if(action==='fill_title')return single('input#productTitle,input[name="title"],.title-input input');
        if(action==='fill_group') {
            const e=window.smartFind?.find('page3','groupInput') || q('input[placeholder*="分组"],[class*="group"] input');
            if(!rendered(e))return result(null,'分组控件未定位或隐藏，不修改');
            const area=e.closest('.next-select')||e.parentElement;
            const selected=area?.querySelector('.next-select-values,.next-select-single,.next-tag-body');
            const actual=String(e.value||selected?.textContent||'').trim();
            return result(!!actual&&!/^(请选择|请选择分组)$/.test(actual),actual?'已有分组：'+actual+'，保留':'分组为空，补填');
        }
        if(action==='fill_price_unit') {
            const area=q('#priceUnit');
            const selected=area?.querySelector('.next-select-values')||area?.querySelector('.next-select-single,.next-select-trigger');
            if(!rendered(area)||!rendered(selected))return result(null,'单位控件未定位或隐藏，不修改');
            const actual=value(selected);
            return result(!!actual&&!/^(请选择|请输入|please select)[\s.。…]*$/i.test(actual),actual&&!/^请选择/.test(actual)?'已有单位，保留':'计量单位为空，补填');
        }
        if(action==='fill_attributes') {
            const fields=buildAttributeFields(product), empty=[], absent=[], skipped=[];
            const required=new Set(fields.required.map(f=>f.lbl));
            for(const f of [...fields.required,...fields.optional].filter(f=>f.val!==''&&f.val!=null)) {
                const area=findFieldContainer('',f.lbl);
                if(!rendered(area)){(required.has(f.lbl)?absent:skipped).push(f.lbl);continue;}
                const values=[...area.querySelectorAll('input:not([type="hidden"]),textarea,.next-tag-body,.next-select-values')].map(value).filter(v=>!/^(请选择|请输入|please select)[\s.。…]*$/i.test(v));
                if(!values.length){(required.has(f.lbl)?absent:skipped).push(f.lbl);continue;}
                if(!values.some(Boolean))empty.push(f.lbl);
            }
            // 现有fillAttributes会先清空整组，不能用于缺项修复。
            return result(empty.length?false:absent.length?null:true,empty.length ? '空字段：'+empty.join('、')+'；仅补这些字段' : absent.length?'必填字段未定位：'+absent.join('、')+'；已读属性保留':'页面属性已有内容，保留'+(skipped.length?'；未定位的可选字段不自动填：'+skipped.join('、'):''));
        }
        if(action==='fill_images'||action==='fill_detail_images') {
            const area=action==='fill_images'?q('#scImages,#struct-image,.posting-field-image,.image-uploader'):all('.gallery-item-container').find(e=>/细节图|Detail shot/i.test(e.textContent));
            if(!area)return result(null,'图片区域未定位，不重选模板');
            const candidates=[...area.querySelectorAll('.image-upload-list-item,.image-item-container,.image-item,.gallery-item-image-wrapper')].filter(e=>e.querySelector('img')||e.querySelector('[style*="background-image"]'));
            const n=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other))).length, expected=action==='fill_images'?6:3;
            return n>=expected?result(true,`已有${n}张，保留`):result(false,`现有${n}/${expected}张；发现缺图，保留已有图片，暂不调用整组重传`);
        }
        if(action==='fill_colors') {
            const values=all('.posting-field-color-select input[role="colorCombobox"]').map(e=>e.value);
            return group(values,values.length,'颜色');
        }
        if(action==='review_color_images')return window.PoloReviewColors?window.PoloReviewColors.inspect(doc):result(null,'颜色图检查模块未加载');
        if(action==='fill_sizes') {
            const es=all('.next-checkbox-wrapper').filter(e=>!e.closest('thead,.next-overlay-wrapper,[class*="filter"]')&&/^(xxs|xs|s|m|l|xl|[2-9]xl|onesize)$/i.test(norm(e.querySelector('.next-checkbox-label')?.textContent)));
            return group(es.map(e=>(e.classList.contains('checked')||e.querySelector('input')?.checked)?'已选':''),1,'尺码');
        }
        if(action==='fill_size_template') {
            const candidates=all('.size-chart-table-main,.country-size-chart-container,.size-chart-qiankun');
            const e=candidates.find(x=>!x.getBoundingClientRect||x.getBoundingClientRect().height>0);
            if(!e)return result(null,'尺码表未定位，不重选模板');
            const cells=[...e.querySelectorAll('td,input,[role="cell"],[role="gridcell"],.next-table-cell')].filter(x=>!x.closest?.('.select-template,.size-chart-select-template-container'));
            if(!cells.length)return result(null,'尺码表数据尚未加载，不重选模板');
            const numeric=/^\s*[<>≤≥~≈]?\s*\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:cm|mm|in|inch|英寸|厘米)?\s*$/i;
            return result(cells.some(x=>numeric.test(value(x))),'仅检查实际表格数字；无数字时也不自动重选或清空模板');
        }
        if(action==='fill_ladder_price') {
            const quantities=all('input[role="input-quantity"]').filter(e=>!e.closest('#struct-ladderPeriod,#ladderPeriod'));
            const prices=all('input[role="input-price"]');
            if(!quantities.length||prices.length!==quantities.length)return result(null,'阶梯价控件尚未完整加载，不修改');
            const empty=[...quantities,...prices].filter(e=>!e.value.trim());
            return result(!empty.length,empty.length?'起订量或价格存在空字段，只补可对应来源的空项':'现有数量和价格均有填写，保留自定义阶梯');
        }
        if(action==='fill_batch_qty')return result(null,'库存仅检查是否空缺；虚拟表全量核对待实现，不覆盖已有库存');
        if(action==='fill_logistics') {
            const fields=logisticsFields(doc),empty=fields.filter(([e])=>e&&!String(e.value||'').trim()),absent=fields.filter(([e])=>!e);
            return result(empty.length?false:absent.length?null:true,empty.length?'仅补空字段：'+empty.map(x=>x[2]).join('、'):absent.length?'部分物流字段未定位，不修改':'发货期及物流已有内容，保留');
        }
        if(action==='fill_box_rule') {
            const es=all('.box-rule-container').filter(e=>e.getBoundingClientRect().height>0);
            if(!es.length)return result(null,'箱规区域未定位');
            return result(es.some(e=>!value(e).includes('添加或关联箱规')&&/\d/.test(value(e))),'检查是否有关联箱规，不比较默认尺寸');
        }
        if(action==='fill_highlights')return single('#struct-textDesc .text-area-list-editor');
        if(action==='fill_company_intro_template') {
            const e=q('#struct-companyDesc textarea');
            const area=q('#detail-company-introduction-card');
            if(!area||!e)return result(null,'公司介绍尚未加载，不修改');
            const galleries=[...area.querySelectorAll('.gallery-item-container')];
            const labels=['Company overview','Customization capabilities','Extended company profile'];
            const missing=labels.filter(label=>{
                const gallery=galleries.find(g=>g.textContent.includes(label));
                return !gallery||!gallery.querySelector('.gallery-item-image-wrapper img,.image-item img,.image-upload-list-item img');
            });
            if(!value(e))missing.push('公司介绍文案');
            return result(!missing.length,missing.length?'公司介绍缺少：'+missing.join('、')+'；保留已有内容，不重选模板':'公司介绍文案及三组模板图片已有内容，保留');
        }
        if(action==='fill_logistics_template') {
            const area=q('#custom-card')||all('[role="all"]').find(e=>e.textContent?.includes('定制服务')&&!e.textContent.includes('物流属性'));
            if(!area)return result(null,'定制服务区域未定位，不修改');
            const selected=area?.querySelector('.select-template .next-select-values,.select-template .next-select-single');
            if(selected&&value(selected)&&value(selected)!=='请选择')return result(true,'已有定制服务模板，保留');
            const checked=[...area.querySelectorAll('input[type="checkbox"]')].filter(e=>e.checked);
            return result(checked.length>0,checked.length?'已有定制服务勾选内容，保留；不以模板名称消失判缺失':'定制服务未勾选；需选择模板，不自动重置其他服务');
        }
        if(action==='fill_faqs') {
            const plan=faqMissing(doc,product);
            if(!plan.rows.length)return result(null,'FAQ未加载或条目不存在，不重建整组');
            if(plan.targets.length)return result(false,'只补能对应源问答的空字段，保留非空文案');
            if(plan.unresolved)return result(null,'存在空FAQ字段，但无法对应源问答，不按行号猜填');
            if(plan.rows.length<plan.wanted.length)return result(false,`FAQ条目缺少${plan.wanted.length-plan.rows.length}条；保留现有条目，待补建`);
            return result(true,'现有FAQ均有内容，保留');
        }
        return result(null,'尚不能安全判断，不修改');
    }
    function mount(getProduct, repair) {
        const save = document.getElementById('polo-save-btn');
        if (!save || document.getElementById('polo-review-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'polo-review-btn'; btn.textContent = '检查并修复（手动测试）';
        btn.dataset.reviewVersion='2026-11-02-preserve-6';
        btn.dataset.reviewFaqVersion=window.PoloReviewFaq?.revision||'unknown';
        btn.style.cssText = 'width:100%;min-height:44px;margin-bottom:8px;border:1px solid #667eea;border-radius:8px;background:#f5f3ff;color:#4338a0;cursor:pointer';
        const output = document.createElement('div'); output.setAttribute('role','status'); output.setAttribute('aria-live','polite');
        output.style.cssText = 'font-size:12px;line-height:1.6;max-height:220px;overflow:auto;white-space:pre-wrap;margin-bottom:8px';
        save.after(btn, output);
        btn.onclick = async () => {
            const product = getProduct();
            if (!product) { output.textContent = '请先加载当前商品数据'; return; }
            btn.disabled = true; btn.setAttribute('aria-busy','true');
            const pageAtStart=location.href;
            const controls = [...document.querySelectorAll('#polo-helper-panel button')].filter(e => e !== btn);
            const disabled = controls.map(e => e.disabled);
            controls.forEach(e => { e.disabled = true; });
            const lines = new Map();
            const report = (label,r) => { lines.set(label, `${r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : '?'} ${label}：${r.detail}`); output.textContent = [...lines.values()].join('\n'); };
            try {
                let quality = score(document);
                if (quality === null) {
                    report('质量检测', result(null, '尚无分数，正在点击质量检测并等待结果…'));
                    try { quality = await detectQuality(document, realClick); }
                    catch (e) { report('质量检测',result(null,e.message+'；继续检查表单空缺')); }
                }
                report('范围', result(null, `质量分${quality ?? '未识别'}，始终检查全部空缺；已有内容保留；本按钮不保存、不推进队列`));
                const rows = await run(checks(product), async action => {
                    if (getProduct() !== product) throw Error('当前商品已切换，停止修复');
                    await repair(product,action); await new Promise(r => setTimeout(r,600));
                }, report, {isCurrent:()=>getProduct()===product&&location.href===pageAtStart});
                const pending = rows.filter(r => r.after.state !== 'pass').length;
                report('结果', result(pending ? null : true, pending ? `${pending}项仍需处理或人工确认；补填内容尚未保存` : '本次检查项通过；请手动保存，再点击检查复核'));
                if (!pending) {
                    report('重新检测',result(null,'各项检查完成，正在重新检测…'));
                    const latest = await detectQuality(document, realClick);
                    report('重新检测',result(true,`最新质量分 ${latest.toFixed(1)}；本次未执行保存，分数不作为保存成功证据`));
                }
            } catch (e) { report('异常',result(null,e.message)); }
            finally { controls.forEach((e,i) => { e.disabled = disabled[i]; }); btn.disabled = false; btn.removeAttribute('aria-busy'); }
        };
    }
    window.PoloPage3Review = { score, run, norm, result, checks, mount, detectQuality, expectedParts, presence, repairEmptyFields };
})();
