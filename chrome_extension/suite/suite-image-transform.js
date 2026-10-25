'use strict';
const SuiteImageTransform = (() => {
    function bounds(data, width, height, tolerance = 12) {
        let left=width, top=height, right=-1, bottom=-1;
        for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
            const i=(y*width+x)*4;
            const background=data[i+3]===0 || (Math.abs(data[i]-data[0])<=tolerance && Math.abs(data[i+1]-data[1])<=tolerance && Math.abs(data[i+2]-data[2])<=tolerance && Math.abs(data[i+3]-data[3])<=tolerance);
            if(!background){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
        }
        return right<left ? {x:0,y:0,width,height} : {x:left,y:top,width:right-left+1,height:bottom-top+1};
    }
    async function apply(blob, action, options = {}) {
        if(!['trimBorder','padSquare','resizeMax'].includes(action)) throw new Error('不支持的图片处理：'+action);
        const image=await createImageBitmap(blob);
        try {
            let crop={x:0,y:0,width:image.width,height:image.height};
            if(action==='trimBorder') {
                const scan=document.createElement('canvas');scan.width=image.width;scan.height=image.height;
                const ctx=scan.getContext('2d');ctx.drawImage(image,0,0);
                crop=bounds(ctx.getImageData(0,0,image.width,image.height).data,image.width,image.height);
            }
            const max=Number(options.max || 1536);
            if(action==='resizeMax' && (!Number.isFinite(max)||max<1||max>16384)) throw new Error('resizeMax 尺寸无效');
            const scale=action==='resizeMax'?Math.min(1,max/Math.max(crop.width,crop.height)):1;
            const w=Math.max(1,Math.round(crop.width*scale)),h=Math.max(1,Math.round(crop.height*scale));
            const canvas=document.createElement('canvas');
            canvas.width=action==='padSquare'?Math.max(w,h):w;canvas.height=action==='padSquare'?Math.max(w,h):h;
            const ctx=canvas.getContext('2d');
            if(action==='padSquare'){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);}
            ctx.drawImage(image,crop.x,crop.y,crop.width,crop.height,(canvas.width-w)/2,(canvas.height-h)/2,w,h);
            return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('图片导出失败')),'image/png'));
        } finally { if(image.close)image.close(); }
    }
    return {apply,bounds};
})();
globalThis.SuiteImageTransform=SuiteImageTransform;
