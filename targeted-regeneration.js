/* 指定重生成：行号(0=颜色图，1起为配置中的步骤顺序)，裸行号为全部。 */
(function(root){
'use strict';
function parse(text){
    const input=String(text||'').replace(/（/g,'(').replace(/）/g,')').replace(/[，、]/g,',');
    const rows=new Map();let offset=0;
    const pattern=/\s*(\d+)(?:\s*[-~—]\s*(\d+))?(?:\s*\(([^()]*)\))?/y;
    while(offset<input.length){
        const separator=input.slice(offset).match(/^[\s,;；]+/);if(separator)offset+=separator[0].length;
        if(offset===input.length)break;
        pattern.lastIndex=offset;const m=pattern.exec(input);
        if(!m)throw Error('格式错误，请使用 4(0,3) 或 4');
        offset=pattern.lastIndex;
        if(offset<input.length&&!/[\s,;；]/.test(input[offset]))throw Error('多行请用空格、逗号或换行分隔');
        let a=Number(m[1]),b=m[2]?Number(m[2]):a;
        if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<1||b<1||Math.abs(a-b)>2000)throw Error('行号或范围无效');
        if(a>b)[a,b]=[b,a];
        let selection=null;
        if(m[3]!==undefined){
            if(/,\s*,/.test(m[3])||!/^\s*\d+(?:[\s,]+\d+)*\s*$/.test(m[3]))throw Error('括号内填写 0 或步骤数字，如 4(0,3)');
            selection=[...new Set(m[3].trim().split(/[\s,]+/).map(Number))];
            if(selection.some(n=>!Number.isSafeInteger(n)))throw Error('步骤数字无效');
        }
        for(let row=a;row<=b;row++){
            const previous=rows.get(row);
            rows.set(row,rows.has(row)?(previous===null||selection===null?null:[...new Set([...previous,...selection])]):selection);
            if(rows.size>2000)throw Error('一次最多指定 2000 行');
        }
    }
    if(!rows.size)throw Error('请填写行号');
    return [...rows].map(([row,selection])=>({row,selection}));
}
function plan(requests,products,getSteps){
    return requests.map(request=>{
        const product=products.find(p=>p.row===request.row);
        if(!product)throw Error('当前 Excel 不存在第 '+request.row+' 行');
        const steps=getSteps(product);
        const numbers=request.selection===null?Array.from({length:steps.length+1},(_,i)=>i):request.selection;
        if(numbers.some(n=>n>steps.length))throw Error('第 '+request.row+' 行只有 '+steps.length+' 个步骤');
        const keys=numbers.filter(n=>n>0).sort((a,b)=>a-b).map(n=>String(steps[n-1].key));
        if(keys.some(k=>!['111','222','333','444','666'].includes(k))||new Set(keys).size!==keys.length)throw Error('第 '+request.row+' 行的步骤输出编号无效');
        return {product,row:request.row,color:numbers.includes(0),keys,labels:numbers.filter(n=>n>0).sort((a,b)=>a-b).map(n=>'步骤'+n+' '+steps[n-1].name)};
    });
}
async function run(jobs,api){
    for(const job of jobs){
        await api.check();await api.select(job.product);
        if(job.color){await api.color(job.product);await api.check();}
        if(job.keys.length===5)await api.suite(job.keys,job.product);
        else for(const key of job.keys){await api.check();await api.suite([key],job.product);}
    }
}
const api={parse,plan,run};root.TargetedRegeneration=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
