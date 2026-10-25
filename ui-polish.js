/* 本模块只处理视觉反馈与键盘交互，不读取任务数据、不调用生成、上传或保存。 */
(() => {
    window.UiPolish?.dispose?.();
    const cleanups=[];
    const disclosures=new WeakMap();
    const revealedImages=new WeakSet(),detailAnimations=new WeakMap();
    let frame=0,toastTimer=0,lastFocus=null,bodyOverflow='',modalInert=[];
    const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    function each(root,selector,fn){
        if(root.matches?.(selector))fn(root);
        root.querySelectorAll?.(selector).forEach(fn);
    }
    function listen(target,name,fn){target.addEventListener(name,fn);cleanups.push(()=>target.removeEventListener(name,fn));}
    function toggleDisclosure(body,expanded){
        if(!body)return;
        const old=disclosures.get(body),start=body.hidden?0:body.getBoundingClientRect().height;
        const currentOpacity=old?getComputedStyle(body).opacity:null;
        old?.animation.cancel();
        const overflow=old?.overflow??body.style.overflow;
        if(reduced()||!body.animate){body.hidden=!expanded;body.style.overflow=overflow;disclosures.delete(body);return;}
        body.hidden=false;
        const end=expanded?body.scrollHeight:0;
        body.style.overflow='hidden';
        const startOpacity=currentOpacity??(expanded?0:1);
        const animation=body.animate([{height:start+'px',opacity:startOpacity},{height:end+'px',opacity:expanded?1:0}],{duration:expanded?340:260,easing:'cubic-bezier(.22,.68,0,1)'});
        disclosures.set(body,{animation,overflow});
        animation.onfinish=()=>{if(disclosures.get(body)?.animation!==animation)return;body.hidden=!expanded;body.style.overflow=overflow;disclosures.delete(body);};
    }
    function enter(element){if(window.matchMedia?.('(max-width: 600px)').matches)requestAnimationFrame(()=>element?.parentElement?.scrollIntoView({block:'start',behavior:reduced()?'auto':'smooth'}));if(!reduced()&&element?.animate)element.animate([{opacity:.8,transform:'translateX(6px)'},{opacity:1,transform:'translateX(0)'}],{duration:300,easing:'cubic-bezier(.22,.68,0,1)'});}
    function settleDetail(panel){
        if(!panel)return;
        detailAnimations.get(panel)?.cancel();
        if(!reduced()&&panel.animate)detailAnimations.set(panel,panel.animate(
            [{opacity:.25,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],
            {duration:420,easing:'cubic-bezier(.22,.68,0,1)'}));
    }
    function revealImages(root){each(root,'.main-image img,.color-img-item img',img=>{
        if(revealedImages.has(img))return;
        revealedImages.add(img);
        const reveal=()=>{if(!reduced()&&img.isConnected&&img.animate)img.animate(
            [{opacity:0},{opacity:1}],{duration:420,easing:'cubic-bezier(.22,.68,0,1)'});};
        if(img.complete&&img.naturalWidth)reveal();
        else img.addEventListener('load',reveal,{once:true});
    });}

    function openImage(src){
        const modal=document.getElementById('imageModal');if(!modal)return;
        if(!modal.classList.contains('show')){lastFocus=document.activeElement;bodyOverflow=document.body.style.overflow;modalInert=[...document.querySelectorAll('.container,.page-header')].map(el=>[el,el.inert]);modalInert.forEach(([el])=>el.inert=true);}
        document.getElementById('modalImage').src=src;
        modal.setAttribute('aria-hidden','false');modal.classList.add('show');document.body.style.overflow='hidden';
        modal.querySelector('button')?.focus({preventScroll:true});
    }
    function closeImage(){
        const modal=document.getElementById('imageModal');if(!modal?.classList.contains('show'))return;
        modal.classList.remove('show');document.body.style.overflow=bodyOverflow;
        modalInert.forEach(([el,value])=>el.inert=value);modalInert=[];
        if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});
        modal.setAttribute('aria-hidden','true');lastFocus=null;
    }
    function toast(message){
        const el=document.getElementById('toast');if(!el)return;
        clearTimeout(toastTimer);el.textContent=message;
        el.dataset.tone=String(message).startsWith('❌')?'error':String(message).startsWith('⚠️')?'warning':String(message).startsWith('✅')?'success':'info';
        el.classList.add('show');toastTimer=setTimeout(()=>el.classList.remove('show'),3200);
    }
    function syncTabs(root){each(root,'.tabs',tabs=>{
        tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','产品信息');
        tabs.querySelectorAll('.tab').forEach(tab=>{
            tab.setAttribute('role','tab');tab.id='ui-tab-'+tab.dataset.tab;tab.tabIndex=tab.classList.contains('active')?0:-1;
            tab.setAttribute('aria-selected',String(tab.classList.contains('active')));tab.setAttribute('aria-controls','tab-'+tab.dataset.tab);
        });
    });}
    function enhance(root=document){
        revealImages(root);
        each(root,'.product-card',card=>{
            card.setAttribute('role','button');card.setAttribute('aria-pressed',String(card.classList.contains('active')));
            card.tabIndex=card.classList.contains('active')?0:-1;
            const row=card.querySelector('.product-row')?.textContent||'';card.setAttribute('aria-label','选择产品 '+row+'，'+(card.querySelector('.product-name')?.textContent||'').slice(0,90));
        });
        const list=document.getElementById('productCards');if(list&&!list.querySelector('[tabindex="0"]')&&list.firstElementChild)list.firstElementChild.tabIndex=0;
        each(root,'.batch-checkbox',box=>{box.setAttribute('role','checkbox');box.tabIndex=0;box.setAttribute('aria-label','选中此产品用于批量发品');box.setAttribute('aria-checked',String(box.classList.contains('checked')));});
        each(root,'.batch-select-all,.batch-skip-uploaded',box=>{box.setAttribute('role','checkbox');box.tabIndex=0;box.setAttribute('aria-checked',String(!!box.querySelector('.checked')));});
        each(root,'.tab-content',panel=>{panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','ui-'+panel.id);});
        syncTabs(root);
        each(root,'img[onclick*="openImageModal"]',img=>{img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','放大查看'+(img.alt||'图片'));});
        each(root,'#uploadArea',el=>{el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label','上传 Excel 表格，也可拖入文件');});
        each(root,'button',button=>button.setAttribute('aria-busy',String(button.disabled&&button.textContent.trim().startsWith('⏳'))));
        each(root,'#toast',el=>{el.setAttribute('role','status');el.setAttribute('aria-live','polite');el.setAttribute('aria-atomic','true');});
        each(root,'#imageModal',el=>{el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','图片预览');el.setAttribute('aria-hidden',String(!el.classList.contains('show')));el.querySelector('button')?.setAttribute('aria-label','关闭图片预览');});
        each(root,'.main-image',area=>{
            const layout=area.firstElementChild;if(!layout)return;
            layout.classList.add('main-image-layout');layout.children[0]?.classList.add('main-image-preview');layout.children[1]?.classList.add('main-image-actions');
            // 兼容当前已打开的页面；源码中的绿色单独样式已删除。
            const button=area.querySelector('#suiteGenBtn');if(button?.style.background)button.style.removeProperty('background');
        });
    }
    function keyboard(event){
        const modal=document.getElementById('imageModal');
        if(modal?.classList.contains('show')){
            if(event.key==='Escape'){event.preventDefault();closeImage();return;}
            if(event.key==='Tab'){event.preventDefault();modal.querySelector('button')?.focus();return;}
        }
        if(event.target.closest('input,select,textarea,[contenteditable=true]'))return;
        const tab=event.target.closest('.tab');
        if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
            event.preventDefault();const tabs=[...tab.parentElement.querySelectorAll('.tab')],index=tabs.indexOf(tab);
            const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];next.click();next.focus();return;
        }
        const checkbox=event.target.closest('.batch-checkbox,.batch-select-all,.batch-skip-uploaded');
        if(checkbox&&['Enter',' '].includes(event.key)){event.preventDefault();checkbox.click();enhance(checkbox);return;}
        const card=event.target.closest('.product-card');
        if(card&&['ArrowUp','ArrowDown'].includes(event.key)){
            event.preventDefault();const next=event.key==='ArrowDown'?card.nextElementSibling:card.previousElementSibling;
            if(next){next.click();next.focus({preventScroll:true});next.scrollIntoView({block:'nearest'});}return;
        }
        const action=event.target.closest('.product-card,.tab,#uploadArea,img[onclick*="openImageModal"]');
        if(action&&action.tagName!=='BUTTON'&&['Enter',' '].includes(event.key)){event.preventDefault();action.click();}
    }
    listen(document,'keydown',keyboard);
    listen(document,'click',event=>{
        const card=event.target.closest('.product-card');if(card)queueMicrotask(()=>{
            document.querySelectorAll('.product-card[tabindex="0"],.product-card[aria-pressed="true"]').forEach(el=>{el.tabIndex=-1;el.setAttribute('aria-pressed','false');});
            const active=document.querySelector('.product-card.active');if(active){active.tabIndex=0;active.setAttribute('aria-pressed','true');}
            enhance(card);
        });
        const tabs=event.target.closest('.tabs');if(tabs)queueMicrotask(()=>syncTabs(tabs));
        const box=event.target.closest('.batch-checkbox,.batch-select-all,.batch-skip-uploaded');if(box)queueMicrotask(()=>enhance(box));
    });
    const pending=new Set();
    const observer=new MutationObserver(records=>{
        for(const record of records)if(record.type==='childList')pending.add(record.target);
        if(frame)return;
        frame=requestAnimationFrame(()=>{frame=0;const roots=[...pending];pending.clear();for(const root of roots)if(root.isConnected&&!roots.some(other=>other!==root&&other.contains?.(root)))enhance(root);});
    });
    observer.observe(document.body,{childList:true,subtree:true});
    enhance();
    window.UiPolish={toggleDisclosure,enter,settleDetail,openImage,closeImage,toast,enhance,
        dispose(){observer.disconnect();cancelAnimationFrame(frame);clearTimeout(toastTimer);cleanups.forEach(fn=>fn());}};
})();
