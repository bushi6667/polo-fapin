/* 与页面交互的上传执行器：限定目标区域，按真实图片数核验，不移除 DOM 冒充删除。 */
(() => {
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const visible=el=>el&&el.getClientRects().length>0;
    const decoded=new Map();
    const UPLOAD_MAX_BYTES=1024*1024;
    async function compressForUpload(blob,name){
        if(!blob.size)throw Error('上传图片为空');
        const extension=type=>type==='image/png'?'.png':type==='image/webp'?'.webp':'.jpg';
        const filename=type=>String(name||'image').replace(/\.[^.]+$/,'')+extension(type);
        if(blob.size<=UPLOAD_MAX_BYTES&&blob.type==='image/jpeg')return new File([blob],filename('image/jpeg'),{type:'image/jpeg'});
        const bitmap=await createImageBitmap(blob);
        try{
            const canvas=document.createElement('canvas');
            let scale=Math.min(1,2560/Math.max(bitmap.width,bitmap.height));
            const encode=quality=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('图片压缩失败')),'image/jpeg',quality));
            for(let attempt=0;attempt<12;attempt++){
                canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
                const ctx=canvas.getContext('2d');if(!ctx)throw Error('图片压缩画布不可用');
                ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
                let best=await encode(.94);
                if(best.size>UPLOAD_MAX_BYTES){
                    let low=.5,high=.94;best=await encode(low);
                    if(best.size<=UPLOAD_MAX_BYTES){for(let n=0;n<7;n++){const quality=(low+high)/2,candidate=await encode(quality);if(candidate.size<=UPLOAD_MAX_BYTES){best=candidate;low=quality;}else high=quality;}}
                }
                if(best.size<=UPLOAD_MAX_BYTES&&best.type==='image/jpeg'){console.info('[上传压缩]',name,blob.size+' → '+best.size+' bytes',canvas.width+'×'+canvas.height);return new File([best],filename('image/jpeg'),{type:'image/jpeg'});}
                if(Math.min(canvas.width,canvas.height)<=640)throw Error('图片无法在保持清晰度的条件下压缩到1MB，请检查素材');
                scale*=.85;
            }
            throw Error('图片压缩后仍超过1MB，已停止上传');
        }finally{bitmap.close();}
    }
    function backgroundSource(item){
        const thumbnail=item.querySelector('.image-upload-list-item-thumbnail [style*="background-image"]');
        const value=thumbnail?.style.backgroundImage||'';
        return value.match(/url\(["']?(.*?)["']?\)/)?.[1]||'';
    }
    function loaded(item){
        if([...item.querySelectorAll('img')].some(img=>img.complete&&img.naturalWidth>0))return true;
        const source=backgroundSource(item);if(!source)return false;
        if(!decoded.has(source)){
            const image=new Image();decoded.set(source,image);image.src=source;
        }
        const image=decoded.get(source);return image.complete&&image.naturalWidth>0;
    }
    function root(kind){
        if(kind==='main')return document.querySelector('#scImages')||document.querySelector('#struct-image,.posting-field-image')||document.querySelector('.image-uploader')||document.querySelector('#image-placeholder,.image-upload-photobank-placeholder')?.parentElement;
        const gallery=[...document.querySelectorAll('.gallery-item-container')].find(el=>/细节图|Detail shot/i.test(el.textContent));
        if(gallery)return gallery;
        const active=document.querySelector('.editor-component-row.active .J_module[module-name="icbu-pc-detailManyImage"],.editor-component-row.active .icbu-pc-detailManyImage');
        if(active)return active;
        const modules=[...document.querySelectorAll('.J_module[module-name="icbu-pc-detailManyImage"]')].filter(visible);
        return modules.length===1?modules[0]:null;
    }
    function items(area){
        const candidates=[...area.querySelectorAll('.image-upload-list-item,.image-item-container,.image-item,.gallery-item-image-wrapper')].filter(el=>el.querySelector('img')||backgroundSource(el));
        return candidates.filter(el=>!candidates.some(other=>other!==el&&el.contains(other)));
    }
    function probe(kind){const area=root(kind);return {found:!!area,count:area?items(area).length:0,canEnable:kind==='detail'&&[...document.querySelectorAll('label')].some(el=>/细节图|Detail shot/i.test(el.textContent))};}
    async function enableDetail(){
        if(root('detail'))return;
        const label=[...document.querySelectorAll('label')].find(el=>/细节图|Detail shot/i.test(el.textContent));
        if(label){const input=label.querySelector('input[type="checkbox"]');if(input&&!input.checked)label.click();}
    }
    async function clear(area){
        if(!items(area).length)return;
        const all=[...area.querySelectorAll('button,.gallery-item-header-delete-all')].find(el=>visible(el)&&(el.matches('.delete-all,.gallery-item-header-delete-all')||/^(删除全部图片|删除全部|全部删除)$/.test(el.textContent.trim())));
        if(all){
            all.click();await sleep(300);
            const dialog=[...document.querySelectorAll('.next-dialog,.next-overlay-inner,[role="dialog"]')].filter(visible).at(-1);
            const confirm=dialog&&[...dialog.querySelectorAll('button')].find(el=>visible(el)&&/^(确定|确认|确认删除)$/.test(el.textContent.trim()));
            if(confirm)confirm.click();
        }else{
            for(let i=0;i<30&&items(area).length;i++){
                const before=items(area).length,item=items(area)[0];
                item.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
                const button=item.querySelector('button.delete,.next-icon-close,[class*="delete"],[class*="remove"]');
                if(!button)throw Error('找不到目标图片删除按钮，已停止，未追加新图');
                button.click();
                for(let n=0;n<20&&items(area).length>=before;n++)await sleep(100);
                if(items(area).length>=before)throw Error('旧图片删除未生效，已停止上传');
            }
        }
        for(let i=0;i<40&&items(area).length;i++)await sleep(100);
        if(items(area).length)throw Error('旧图片未清空，已停止上传');
    }
    async function perform(kind,files){
        const expected=kind==='main'?6:3;
        if(!Array.isArray(files)||files.length!==expected)throw Error('上传图片数量不正确，未操作页面');
        // 先验证全部文件，成功后才清空原图。
        let compressed=0;
        const progress=(phase,done)=>{try{chrome.runtime.sendMessage({action:'publishImageProgress',phase,done,total:files.length}).catch(()=>{});}catch(_){}};
        progress('compressing',0);
        let prepared;
        try{prepared=await Promise.all(files.map(async file=>{
            if(!/^data:image\/(jpeg|png|webp);base64,/.test(file.dataUrl||''))throw Error('上传素材格式无效');
            const response=await fetch(file.dataUrl),blob=await response.blob();if(!blob.size)throw Error('上传图片为空');
            const result=await compressForUpload(blob,file.name);progress('compressing',++compressed);return result;
        }));}catch(error){progress('error',compressed);throw error;}
        progress('uploading',compressed);
        globalThis.PublicationUploadAudit={kind,compressedAt:Date.now(),files:prepared.map(file=>({name:file.name,type:file.type,bytes:file.size})),uploadStartedAt:null};
        document.documentElement.dataset.publicationUploadAudit=JSON.stringify(globalThis.PublicationUploadAudit);
        if(kind==='detail')await enableDetail();
        // 等上传区出现：原来 30×300ms=9s，慢网下表单还没渲染完就判失败（真机复现），放宽到 30s
        let area;for(let i=0;i<60;i++){area=root(kind);if(area)break;await sleep(500);}
        if(!area)throw Error(kind==='detail'?'未找到细节图区域，请先选择详情模板':'未找到主图上传区域');
        area.scrollIntoView({block:'center'});
        area.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
        await clear(area);
        let input;
        for(let i=0;i<20;i++){
            area=root(kind)||area;
            input=area.querySelector('input[type="file"][multiple]');if(input)break;
            const hover=(area.querySelector('.image-upload-photobank-placeholder')||area.querySelector('.image-upload-list-item,.tips,.image-upload-content'))||area;
            hover.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
            await sleep(250);
            // 新版主图入口将本地上传菜单挂在 body 的 balloon 中。仅接受唯一可见的主图上传菜单。
            if(kind==='main'){
                const portals=[...document.querySelectorAll('.next-balloon')].filter(el=>visible(el)&&/本地上传/.test(el.textContent)&&/从图片银行选取/.test(el.textContent));
                if(portals.length===1){input=portals[0].querySelector('.upload-select-inner input[type="file"][multiple]');if(input)break;}
            }
        }
        if(!input)throw Error('未找到目标区域的多图上传输入框，未上传到其他区域');
        // 详情组件会按文件名重排批量输入，逐张等待完成以保持 333→666→222。
        const batches=kind==='detail'?prepared.map(file=>[file]):[prepared];
        let uploaded=0;
        for(const batch of batches){
            area=root(kind)||area;
            input=area.querySelector('input[type="file"][multiple]')||input;
            const transfer=new DataTransfer();batch.forEach(file=>transfer.items.add(file));input.files=transfer.files;
            globalThis.PublicationUploadAudit.uploadStartedAt=Date.now();
            document.documentElement.dataset.publicationUploadAudit=JSON.stringify(globalThis.PublicationUploadAudit);
            input.dispatchEvent(new Event('change',{bubbles:true}));
            uploaded+=batch.length;
            let stable=0,done=false;
            for(let i=0;i<180;i++){
                area=root(kind)||area;
                if(area.querySelector('.upload-fail,.upload-error,.upload-failed,[data-status="error"]'))throw Error('页面报告图片上传失败');
                const current=items(area),busy=area.querySelector('.uploading,.is-uploading,[data-status="uploading"]');
                const ready=current.length===uploaded&&!busy&&current.every(loaded);
                stable=ready?stable+1:0;
                if(stable>=2){done=true;break;}
                await sleep(500);
            }
            if(!done)throw Error('上传未通过数量和加载校验：期望 '+uploaded+' 张，实际 '+items(area).length+' 张');
        }
        progress('completed',compressed);
        return {ok:true,count:items(area).length,expectedCount:expected};
    }
    globalThis.PublicationDom={probe,perform,compressForUpload};
})();
