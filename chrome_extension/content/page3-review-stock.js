/* 虚拟SKU表：用颜色/尺码标识覆盖范围，只补空库存，不调用批量覆盖。 */
(() => {
    'use strict';
    const norm = v => String(v || '').replace(/\s+/g,'').toLowerCase();
    function classify(rows, expected) {
        const known=new Map(rows.map(r=>[r.key,r]));
        const absent=expected.filter(key=>!known.has(key));
        const empty=[...known.values()].filter(r=>!String(r.value??'').trim());
        return {state:absent.length?'unknown':empty.length?'fail':'pass',detail:absent.length?`尚未读到${absent.length}个规格，不判通过`:empty.length?`${empty.length}个规格库存为空，仅补空项`:`${known.size}个规格库存已有内容，保留`,missingKeys:absent,emptyKeys:empty.map(r=>r.key)};
    }
    async function scan(doc, write) {
        const area=doc.querySelector('#struct-sku');
        if(!area)return {state:'unknown',detail:'规格表未定位，不修改'};
        area.scrollIntoView({block:'center'});
        await new Promise(r=>setTimeout(r,600));
        const scroll=area.querySelector('.virtualized-table-scroll-wrapper');
        const colors=[...doc.querySelectorAll('.posting-field-color-select input[role="colorCombobox"]')].map(e=>norm(e.value)).filter(Boolean);
        const sizeLabels=[...doc.querySelectorAll('.next-checkbox-wrapper')].filter(e=>!e.closest('thead,.next-overlay-wrapper,[class*="filter"]')&&(e.classList.contains('checked')||e.querySelector('input')?.checked)).map(e=>norm(e.querySelector('.next-checkbox-label')?.textContent)).filter(s=>/^(s|m|l|xl|xxl|[2-9]xl|xxs|xs|onesize)$/.test(s));
        const sizes=[...new Set(sizeLabels)],expected=colors.flatMap(c=>sizes.map(s=>c+'|'+s));
        if(!colors.length||!sizes.length)return {state:'unknown',detail:'无法建立颜色/尺码清单，不修改库存'};
        const old=scroll?.scrollTop||0, rows=new Map();
        const max=scroll?Math.max(0,scroll.scrollHeight-scroll.clientHeight):0;
        const step=scroll?Math.max(48,Math.floor(scroll.clientHeight/2)):1;
        try {
            // 首次渲染可能还在补行高；覆盖不全时只再扫描一轮，非空库存不写入。
            for(let pass=0;pass<2;pass++) {
            for(let y=0;y<=max+step;y+=step) {
                if(scroll){scroll.scrollTop=Math.min(y,max);await new Promise(r=>setTimeout(r,250));}
                let color='';
                for(const row of area.querySelectorAll('tbody tr')) {
                    const parts=String(row.innerText||'').split(/\s+/).filter(Boolean);
                    // 多词颜色用整个单元格识别，尺码用空格归一化。
                    const cells=[...row.querySelectorAll('td')].map(e=>norm(e.innerText));
                    const colorCell=cells.find(v=>colors.includes(v));
                    if(colorCell)color=colorCell;
                    const size=cells.find(v=>sizes.includes(v))||sizes.find(v=>parts.some(p=>norm(p)===v));
                    const input=row.querySelector('input[placeholder="请输入"]');
                    if(!input||!color||!size)continue;
                    const key=color+'|'+size;
                    if(!expected.includes(key))continue;
                    if(write&&!String(input.value||'').trim())await write(input,key);
                    rows.set(key,{key,value:input.value});
                }
                if(y>=max)break;
            }
            if(expected.every(key=>rows.has(key)))break;
            await new Promise(r=>setTimeout(r,400));
            }
        } finally {if(scroll)scroll.scrollTop=old;}
        return classify([...rows.values()],expected);
    }
    window.PoloReviewStock={scan,classify};
})();
