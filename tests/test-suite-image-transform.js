const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const canvases=[];let closed=0;
const env={Uint8ClampedArray,createImageBitmap:async()=>({width:4,height:2,close:()=>closed++}),document:{createElement:()=>{const c={width:0,height:0,getContext:()=>({fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(32)})}),toBlob:cb=>cb({size:10})};canvases.push(c);return c;}}};
env.globalThis=env;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chrome_extension/suite/suite-image-transform.js'),'utf8'),env);
(async()=>{
 const pixels=new Uint8ClampedArray(5*5*4).fill(255);
 for(let y=1;y<=3;y++)for(let x=1;x<=3;x++){const i=(y*5+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}
 assert.deepStrictEqual(JSON.parse(JSON.stringify(env.SuiteImageTransform.bounds(pixels,5,5))),{x:1,y:1,width:3,height:3});
 await env.SuiteImageTransform.apply({},'padSquare');assert.strictEqual(canvases.at(-1).width,4);assert.strictEqual(canvases.at(-1).height,4);
 await env.SuiteImageTransform.apply({},'resizeMax',{max:2});assert.strictEqual(canvases.at(-1).width,2);assert.strictEqual(canvases.at(-1).height,1);
 await assert.rejects(()=>env.SuiteImageTransform.apply({},'resizeMax',{max:-1}));
 assert.strictEqual(closed,3,'bitmaps always released');
 console.log('PASS actual border bounds, square padding, aspect resize, invalid dimensions, bitmap cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
