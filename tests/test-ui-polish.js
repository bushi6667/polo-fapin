const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('ui-polish.js','utf8');let reduce=false,timerId=0;const timers=new Map(),events=new Map();
function element(){const classes=new Set();return {hidden:false,scrollHeight:250,style:{overflow:''},inert:false,isConnected:true,attrs:{},dataset:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},focus(){doc.activeElement=this;},querySelectorAll(){return[];},querySelector(){return null;},getBoundingClientRect(){return {height:this.hidden?0:100};},animate(frames,options){const animation={frames,options,cancelled:false,cancel(){this.cancelled=true;}};this.lastAnimation=animation;return animation;}};}
const modal=element(),close=element(),image=element(),toast=element(),container=element(),header=element(),original=element();header.inert=true;
modal.querySelector=()=>close;
const els={imageModal:modal,modalImage:image,toast};
const doc={body:{style:{overflow:'auto'}},activeElement:original,querySelectorAll:selector=>selector==='.container,.page-header'?[container,header]:[],getElementById:id=>els[id]||null,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener(){}};
const env={getComputedStyle:()=>({opacity:"0.55"}),document:doc,window:{matchMedia:()=>({matches:reduce})},MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},queueMicrotask:fn=>fn(),setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
vm.createContext(env);vm.runInContext(source,env);const ui=env.window.UiPolish;
// 动画被后续点击打断时，旧的结束回调不得隐藏新展开的内容。
const body=element();body.hidden=true;ui.toggleDisclosure(body,true);const opening=body.lastAnimation;assert(!body.hidden);ui.toggleDisclosure(body,false);const closing=body.lastAnimation;assert(opening.cancelled);ui.toggleDisclosure(body,true);const reopening=body.lastAnimation;assert.equal(reopening.frames[0].opacity,"0.55");closing.onfinish();assert(!body.hidden);reopening.onfinish();assert(!body.hidden);assert.equal(body.style.overflow,'');
reduce=true;ui.toggleDisclosure(body,false);assert(body.hidden);ui.toggleDisclosure(body,true);assert(!body.hidden);
// 大图关闭后准确恢复已有 inert、滚动设置和触发者焦点。
ui.openImage('test.png');assert(container.inert&&header.inert);assert.equal(doc.activeElement,close);assert.equal(doc.body.style.overflow,'hidden');ui.closeImage();assert.equal(container.inert,false);assert.equal(header.inert,true);assert.equal(doc.body.style.overflow,'auto');assert.equal(doc.activeElement,original);assert.equal(modal.attrs['aria-hidden'],'true');
// 新提示替换旧提示时，仅最后一个计时器生效。
ui.toast('first');ui.toast('✅ second');assert.equal(timers.size,1);assert.equal(toast.dataset.tone,'success');timers.values().next().value();assert(!toast.classList.contains('show'));

const css=fs.readFileSync('ui-polish.css','utf8');
function luminance(hex){const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4));return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
for(const name of ['--ui-primary','--ui-primary-hover']){const hex=css.match(new RegExp(name+': (#[0-9a-f]{6})'))[1];assert(1.05/(luminance(hex)+.05)>=4.5,'primary text contrast '+name);}
assert(css.includes('@media(prefers-reduced-motion:reduce)'));assert(!css.includes('transition:all'));
console.log('PASS interruptible disclosure, reduced-motion behavior, modal focus/inert/scroll restoration, toast timing, primary normal/hover contrast');
