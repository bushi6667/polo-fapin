/* 发品使用套图索引中的成品；只为上传生成压缩副本，不修改原 PNG。 */
(() => {
    async function uploadCopy(blob){
        const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');
        try{
            let scale=1;
            while(scale>=.3){
                canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
                const g=canvas.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,canvas.width,canvas.height);g.drawImage(bitmap,0,0,canvas.width,canvas.height);
                for(const quality of [.95,.9,.85,.8,.7,.6,.5,.4,.3]){
                    const output=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
                    if(output&&output.size<=3*1024*1024)return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('上传副本读取失败'));reader.readAsDataURL(output);});
                }
                scale-=.1;
            }
            throw Error('图片压缩后仍超过 3MB，未上传');
        }finally{bitmap.close();canvas.width=canvas.height=0;}
    }
    async function read({fileKey,rowNum,keys}){
        if(!fileKey||!Number.isInteger(rowNum)||rowNum<1||!Array.isArray(keys)||!keys.length||keys.some(k=>!['111','444','222','333','666'].includes(k)))throw Error('上传图片请求身份或编号无效');
        const folder=(typeof loadedFileName!=='undefined'&&loadedFileName)?loadedFileName:'';
        // 磁盘优先：<文件名>/rowN/<编号>.png 或 .jpg（两种后缀都试）；读不到才回落到索引里的旧缓存（兼容历史数据）
        let diskFiles=null;
        if(typeof PageDirectories!=='undefined'&&PageDirectories.dispatch&&folder){
            try{
                const resp=await PageDirectories.dispatch({action:'pageReadSuite',fileFolder:folder,rowNum,keys});
                if(resp&&Array.isArray(resp.files))diskFiles=resp.files;
            }catch(_){diskFiles=null;}
        }
        const files=[];
        for(const key of keys){
            const hit=diskFiles&&diskFiles.find(f=>String(f.key)===key);
            if(hit&&hit.dataUrl){
                const blob=await(await fetch(hit.dataUrl)).blob();
                files.push({key,dataUrl:await uploadCopy(blob),fromDisk:true});
                continue;
            }
            // 只用磁盘：读不到就报错，不再拿 IndexedDB 旧缓存顶上（用户要求"只用磁盘"）
            const reason=(hit&&hit.error)?hit.error:('磁盘上没有 '+folder+'/row'+rowNum+'/'+key+'.png / '+key+'.jpg');
            throw Error('第 '+rowNum+' 行 '+key+'：'+reason);
        }
        return files;
    }
    window.PublicationImageSource={read,uploadCopy};
})();
