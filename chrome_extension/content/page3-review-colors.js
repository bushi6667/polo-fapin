/* 颜色规格图独立检查；只补缺图，不改颜色名称，不批量替换。 */
(() => {
    'use strict';
    const norm=v=>String(v||'').trim().toLowerCase();
    function inspect(doc) {
        const inputs=[...doc.querySelectorAll('.posting-field-color-select input[role="colorCombobox"]')];
        if(!inputs.length)return {state:'unknown',detail:'颜色区域未加载',missing:[]};
        const missing=[];
        for(let i=0;i<inputs.length;i++) {
            const input=inputs[i],label=String(input.value||'').trim(),row=input.closest('.item,[role="item"]');
            if(!label||!row)return {state:'unknown',detail:'颜色名称或目标行未确定，不上传规格图',missing:[]};
            const has=[...row.querySelectorAll('.value-preview.uploaded img')].some(e=>e.getAttribute('src'));
            if(!has)missing.push({input,row,index:i,label,key:norm(label)});
        }
        return {state:missing.length?'fail':'pass',detail:missing.length?'缺少规格图：'+missing.map(x=>x.label).join('、')+'；仅补缺图':'现有颜色规格图完整，保留',missing};
    }
    async function repair(doc,product,api) {
        const initial=inspect(doc);
        for(const target of initial.missing) {
            if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止颜色补图');
            if(!['white','black','gray','navy'].includes(target.key))throw Error('颜色 '+target.label+' 无明确图片来源，不猜填');
            const current=inspect(doc).missing.find(x=>x.input===target.input);
            if(!current)continue;
            if(current.label!==target.label)throw Error('颜色名称已改变，停止补图');
            const source=await api.read(target.key,product);
            if(!source?.ok||!source.url||source.fromDisk!==true)throw Error('未取得 '+target.label+' 的本地图片来源，不使用旧缓存猜填');
            if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止颜色补图');
            const latest=inspect(doc).missing.find(x=>x.input===target.input);
            if(!latest)continue;
            if(latest.label!==target.label)throw Error('颜色名称已改变，停止补图');
            const result=await api.upload(target,source.url);
            if(!result?.ok)throw Error(result?.error||'颜色规格图补填未完成');
        }
    }
    window.PoloReviewColors={inspect,repair};
})();
