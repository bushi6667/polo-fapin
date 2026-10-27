/* 上传图片清单：类目来自产品资料；不读取页面图片猜类目。 */
(() => {
    const BANK=Object.freeze({polo:['产线','刺绣','LOGO','颜色'],shirt:['产线','刺绣','LOGO','颜色'],'t-shirt':['产线','印花','LOGO','面料'],'hooded-sweatshirt':['1','2-2','3','4'],'non-hooded-sweatshirt':['1','2-1','3','4']});
    function category(product){
        // 必须优先用完整类目名 category：_categoryType 只是粗类型（帽衫恒为 "sweatshirt"），
        // 用它判会把有帽卫衣当成无帽卫衣，传错 4 张公共图（真机已复现）。
        const raw=String(product.category||product._categoryType||'');
        const value=raw.trim().toLowerCase().replace(/\(\d+\)/g,'').trim().replace(/\s+/g,'-');
        // 先判帽型：non-hooded 里也含 "hood"，顺序不能反
        if(/non-?hood|无帽|不带帽/.test(value))return 'non-hooded-sweatshirt';
        if(/hood|连帽|有帽|带帽/.test(value))return 'hooded-sweatshirt';
        if(value.includes('polo'))return 'polo';
        if(value.includes('t-shirt')||value==='tshirt')return 't-shirt';
        if(/^shirt(?:$|-)/.test(value))return 'shirt';
        // 只剩 "sweatshirt" 这类粗类型：宁可报错，也不能猜一个帽型去传错图
        if(value.includes('sweatshirt'))throw Error('类目缺少帽型信息（有帽/无帽），不能选择上传图片：'+raw);
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
        // 磁盘上的成品可能是 png 也可能是 jpg（压缩后转存 jpg）：文件名跟着真实类型走，两种都收。
        const extension=dataUrl=>{
            const mime=String(dataUrl||'').match(/^data:image\/(jpeg|jpg|png|webp);base64,/i);
            const type=mime?mime[1].toLowerCase():'jpeg';
            return type==='png'?'.png':type==='webp'?'.webp':'.jpg';
        };
        const files=spec.keys.map(key=>{
            const file=generated.find(f=>f.key===key);
            if(!file||!/^data:image\/(jpeg|png|webp);base64,/.test(file.dataUrl||''))throw Error('缺少本产品生成图 '+key);
            return {...file,name:key+extension(file.dataUrl)};
        });
        for(let i=0;i<spec.bank.length;i++){
            const blob=await readBank('assets/publication-bank/'+spec.category+'/'+(i+1)+'.jpg');
            files.push({name:'bank_'+(i+1)+'.jpg',label:spec.bank[i],dataUrl:await dataUrl(blob)});
        }
        return {category:spec.category,files,expectedCount:kind==='main'?6:3};
    }
    globalThis.PublicationImages={category,plan,prepare};
})();
