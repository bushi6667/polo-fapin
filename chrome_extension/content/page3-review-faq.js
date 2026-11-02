/* FAQ缺项计划：按问题/答案身份匹配，不用错位行号猜答案，不删除已有条目。 */
(() => {
    'use strict';
    const norm=v=>String(v||'').replace(/\s+/g,'').toLowerCase();
    const question=row=>row.querySelector('.question input');
    const answer=row=>row.querySelector('.answers textarea[data-real="true"]');
    function plan(doc,wanted) {
        const rows=[...doc.querySelectorAll('#struct-companyFaqDesc .company-faq-desc .item')];
        const targets=[];let unresolved=0;
        // 完整保留已有问答；只把尚未出现的唯一源问答分配给全空行。
        const used=new Set(),blankRows=[];let sourceKnown=new Set(wanted.map(f=>norm(f.q))).size===wanted.length;
        for(const row of rows) {
            const q=question(row),a=answer(row);
            if(!q||!a){sourceKnown=false;continue;}
            if(!q.value.trim()&&!a.value.trim()){blankRows.push(row);continue;}
            const matches=wanted.filter(f=>q.value.trim()?norm(q.value)===norm(f.q):norm(a.value)===norm(f.a));
            if(matches.length!==1||used.has(norm(matches[0].q))){sourceKnown=false;continue;}
            used.add(norm(matches[0].q));
        }
        const remaining=wanted.filter(f=>!used.has(norm(f.q)));
        const blankSources=new Map(sourceKnown&&remaining.length>=blankRows.length?blankRows.map((r,i)=>[r,remaining[i]]):[]);
        rows.forEach((row,i)=>{
            const q=question(row),a=answer(row);
            if(!q||!a){unresolved++;return;}
            if(q.value.trim()&&a.value.trim())return;
            const matches=wanted.filter(f=>(q.value.trim()&&norm(q.value)===norm(f.q))||(a.value.trim()&&norm(a.value)===norm(f.a)));
            let match=matches.length===1?matches[0]:undefined;
            if(!match&&!q.value.trim()&&!a.value.trim())match=blankSources.get(row);
            if(!match){unresolved++;return;}
            // 每个字段写入前后都重新生成缺项计划，避免前一个字段提交后沿用旧节点。
            const target=(input,value,label)=>{
                const entry=[input,value,label,()=>{
                    const candidates=plan(doc,wanted).targets.filter(t=>norm(t.sourceQuestion)===norm(match.q)&&t[2]===label);
                    return candidates.length===1?candidates[0][0]:null;
                }];
                entry.sourceQuestion=match.q;
                return entry;
            };
            if(!q.value.trim())targets.push(target(q,match.q,'FAQ问题'));
            if(!a.value.trim())targets.push(target(a,match.a,'FAQ答案'));
        });
        const present=new Set(rows.map(r=>norm(question(r)?.value)).filter(Boolean));
        let missingPairs=wanted.filter(f=>!present.has(norm(f.q)));
        // 自定义问题、重复源问题或全空行造成身份不唯一时，不自动新增重复FAQ。
        if(new Set(wanted.map(f=>norm(f.q))).size!==wanted.length||missingPairs.length!==wanted.length-rows.length)missingPairs=[];
        return {rows,wanted,targets,unresolved,missingPairs};
    }
    async function appendMissing(doc,wanted,api) {
        const wait=api.wait||((ms)=>new Promise(r=>setTimeout(r,ms)));
        const pending=plan(doc,wanted).missingPairs;
        for(const pair of pending) {
            if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止FAQ补建');
            const current=plan(doc,wanted);
            if(!current.missingPairs.some(f=>norm(f.q)===norm(pair.q)))throw Error('FAQ内容已变化，停止使用旧缺项计划');
            const container=doc.querySelector('#struct-companyFaqDesc .company-faq-desc');
            const add=container?.querySelector('.add-items');
            if(!add)throw Error('未找到FAQ添加按钮，已有条目保持');
            const before=current.rows.length;
            add.scrollIntoView({block:'center'});await api.click(add);
            for(let i=0;i<12&&plan(doc,wanted).rows.length===before;i++)await wait(100);
            if(plan(doc,wanted).rows.length===before) {
                add.click();
                for(let i=0;i<12&&plan(doc,wanted).rows.length===before;i++)await wait(100);
            }
            const rows=plan(doc,wanted).rows;
            if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止FAQ补建');
            if(rows.length!==before+1)throw Error('FAQ新增结果不唯一或未生效，停止补建');
            const row=rows.at(-1),q=question(row),a=answer(row);
            if(!q||!a||q.value.trim()||a.value.trim())throw Error('新FAQ行已有内容或未就绪，停止覆盖');
            await api.write([[q,pair.q,'新增FAQ问题']]);
            // 问题提交会使平台替换整行；用唯一问题身份重新取得答案框。
            if(api.isCurrent&&!api.isCurrent())throw Error('商品已切换，停止FAQ补建');
            const fresh=plan(doc,wanted).rows.filter(r=>norm(question(r)?.value)===norm(pair.q));
            if(fresh.length!==1)throw Error('新增FAQ身份不唯一，停止填答案');
            const freshAnswer=answer(fresh[0]);
            if(!freshAnswer)throw Error('新增FAQ答案框未加载');
            if(!freshAnswer.value.trim())await api.write([[freshAnswer,pair.a,'新增FAQ答案',()=>{
                const matches=plan(doc,wanted).rows.filter(r=>norm(question(r)?.value)===norm(pair.q));
                return matches.length===1?answer(matches[0]):null;
            }]]);
            await wait(150);
            const committed=plan(doc,wanted).rows.filter(r=>norm(question(r)?.value)===norm(pair.q));
            if(committed.length!==1||!answer(committed[0])?.value.trim())throw Error('新增FAQ答案未提交，停止新增后续条目');
        }
    }
    window.PoloReviewFaq={plan,appendMissing,revision:'2026-11-02-resolve-5'};
})();
