/* 上传图片清单：类目来自产品资料；不读取页面图片猜类目。 */
(() => {
    const BANK=Object.freeze({polo:['产线','刺绣','LOGO','颜色'],shirt:['产线','刺绣','LOGO','颜色'],'t-shirt':['产线','印花','LOGO','面料'],'hooded-sweatshirt':['1','2-2','3','4'],'non-hooded-sweatshirt':['1','2-1','3','4']});
    function category(product){
        const value=String(product._categoryType||product.category||'').trim().toLowerCase().replace(/\(\d+\)/g,'').trim().replace(/\s+/g,'-');
        if(value.includes('non-hood')||value==='sweatshirt')return 'non-hooded-sweatshirt';
        if(value.includes('hooded-sweatshirt')||value==='hoodie')return 'hooded-sweatshirt';
        if(value.includes('polo'))return 'polo';
        if(value.includes('t-shirt')||value==='tshirt')return 't-shirt';
        if(/^shirt(?:$|-)/.test(value))return 'shirt';
        throw Error('产品类目不明确，不能选择上传图片：'+value);
    }
    function plan(product,kind){
        const canonical=category(product);
        if(kind!=='main'&&kind!=='detail')throw Error('未知图片上传类型');
        return {category:canonical,keys:kind==='main'?['444','111']:['333','666','222'],bank:kind==='main'?BANK[canonical]:[]};
    }
    async function dataUrl(blob){
        if(!/^image\/(jpeg|png|webp)$/i.test(blob.type))throw Error('公共图不是支持的图片');
        const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
        for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        return 'data:'+blob.type+';base64,'+btoa(binary);
    }
    async function prepare(product,kind,readGenerated,readBank){
        const spec=plan(product,kind),fileKey=product._publishFileKey,rowNum=product.row;
        if(!fileKey||!Number.isInteger(rowNum)||rowNum<1)throw Error('产品缺少原始文件与行号，不能上传');
        const generated=await readGenerated({fileKey,rowNum,keys:spec.keys});
        const files=spec.keys.map(key=>{
            const file=generated.find(f=>f.key===key);
            if(!file||!/^data:image\/(jpeg|png|webp);base64,/.test(file.dataUrl||''))throw Error('缺少本产品生成图 '+key);
            return {...file,name:key+'.jpg'};
        });
        for(let i=0;i<spec.bank.length;i++){
            const blob=await readBank('assets/publication-bank/'+spec.category+'/'+(i+1)+'.jpg');
            files.push({name:'bank_'+(i+1)+'.jpg',label:spec.bank[i],dataUrl:await dataUrl(blob)});
        }
        return {category:spec.category,files,expectedCount:kind==='main'?6:3};
    }
    globalThis.PublicationImages={category,plan,prepare};
})();
