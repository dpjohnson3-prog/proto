// Runs the PORTED module (app/src/counter.js) through the same synthetic
// camera used to validate the prototype, to prove the port still counts.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { initCounter } = await import(path.join(ROOT, 'src/counter.js'));

const HTML = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const IDS = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
const DTBASE = 1000/60;
function rng(s0){let s=s0>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

function stubDom(lumaRef){
  const rafQ=[]; let nowMs=0; const els=new Map();
  const CTX=new Proxy({},{get:(t,k)=>{
    if(k==='canvas')return{width:600,height:168};
    if(k==='getImageData')return(x,y,w,h)=>{
      const v=Math.max(0,Math.min(255,lumaRef.f()));
      const d=new Uint8ClampedArray(w*h*4);
      for(let i=0;i<w*h;i++){d[i*4]=v;d[i*4+1]=v;d[i*4+2]=v;d[i*4+3]=255;}
      return {data:d};};
    return ()=>{};}});
  function El(id){const cls=new Set();return{id,textContent:'',disabled:false,offsetWidth:1,style:{},
    classList:{add:c=>cls.add(c),remove:c=>cls.delete(c),contains:c=>cls.has(c),
      toggle:(c,on)=>{on?cls.add(c):cls.delete(c);}},_cls:cls,
    appendChild(){},remove(){},insertBefore(){},get parentNode(){return{insertBefore(){}};},
    nextSibling:null,width:600,height:168,getContext:()=>CTX};}
  const doc={getElementById(id){if(!IDS.has(id)&&!els.has(id))return null;
      if(!els.has(id))els.set(id,El(id));return els.get(id);},
    createElement(){return El('tmp');},
    addEventListener(){},};
  const video=doc.getElementById('cam');
  video.videoWidth=640;video.videoHeight=480;video.play=()=>Promise.resolve();
  globalThis.document=doc;
  globalThis.location={search:''};
  globalThis.performance={now:()=>nowMs};
  globalThis.requestAnimationFrame=cb=>{rafQ.push(cb);return rafQ.length;};
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,value:{mediaDevices:{getUserMedia:()=>Promise.resolve({getTracks:()=>[]})}}});
  const w={};w.self=w;w.top=w;globalThis.window=w;globalThis.self=w;globalThis.top=w;
  return {doc,tick(ms){nowMs+=ms;const q=rafQ.splice(0,rafQ.length);for(const cb of q)cb(nowMs);},
          now:()=>nowMs};
}

async function trial(o){
  const DT=1000/(o.FPS||60);
  const lumaRef={f:()=>128};
  const H=stubDom(lumaRef);
  const r=rng(o.seed||7);
  let finished=null;
  const c=initCounter({goal:999,onFinish:(mode,count)=>{finished={mode,count};}});
  c.setGoal(999);
  lumaRef.f=()=>{
    const t=H.now();
    if(t<6000){const s=t<900?-o.exposureStep*(1-t/900):0;
      return o.base+s+(o.calAmp/2)*Math.cos(2*Math.PI*t/3000)+(r()-0.5)*o.noise;}
    const ts=t-6000;
    if(o.mode==='still')return o.base+o.drift*(ts/o.setMs)+(r()-0.5)*o.noise+0.6*Math.sin(2*Math.PI*ts/4000);
    const fl=(ts>o.flashAt&&ts<o.flashAt+120)?o.flashAmp:0;
    return o.base+o.drift*(ts/o.setMs)+fl+(o.calAmp*o.workFrac/2)*Math.cos(2*Math.PI*ts/o.period)+(r()-0.5)*o.noise;
  };
  H.doc.getElementById('startBtn').onclick.call(H.doc.getElementById('startBtn'));
  for(let i=0;i<6;i++) await Promise.resolve();
  while(H.now()<6000+o.setMs) H.tick(DT);
  return parseInt(H.doc.getElementById('countVal').textContent,10)||0;
}

const B={base:128,calAmp:44,noise:0.7,exposureStep:22,workFrac:0.55,period:1600,
         drift:9,flashAt:12000,flashAmp:14,setMs:24000};
const SEEDS=[7,11,23,41,97];
const fams={};const add=(f,o,w)=>{(fams[f]=fams[f]||[]).push([o,w]);};
for(const seed of SEEDS){
  for(const wf of [0.9,0.75,0.6,0.45,0.32,0.25]) add('depth',{...B,seed,workFrac:wf,flashAmp:0},15);
  for(const p of [1000,1400,1800,2400,3000]){const n=Math.round(24000/p);
    add('cadence',{...B,seed,period:p,workFrac:0.5,setMs:n*p,flashAmp:0},n);}
  for(const d of [0,20,40,60,80]) add('drift',{...B,seed,drift:d,workFrac:0.5,flashAmp:0},15);
  for(const nz of [1,3,6]) add('noise',{...B,seed,noise:nz,workFrac:0.5,flashAmp:0},15);
  for(let off=0;off<1600;off+=200) add('flash',{...B,seed,flashAt:12000+off,workFrac:0.5},15);
  for(const fa of [-25,-15,15,25,35]) add('flashAmp',{...B,seed,flashAmp:fa,workFrac:0.5},15);
  for(const ex of [0,15,35]) add('exposure',{...B,seed,exposureStep:ex,workFrac:0.5,flashAmp:0},15);
  for(const FPS of [24,30,45,60,120]) add('fps',{...B,seed,FPS,workFrac:0.5,flashAmp:0},15);
  add('still',{...B,seed,mode:'still',setMs:22000,drift:9},0);
  add('still',{...B,seed,mode:'still',setMs:22000,drift:35},0);
  add('still',{...B,seed,mode:'still',setMs:22000,noise:4,drift:9},0);
}
let TM=0,TP=0,TR=0;
for(const [fam,list] of Object.entries(fams)){
  let miss=0,ph=0,reps=0;
  for(const [o,want] of list){
    const got=await trial(o); const d=got-want; reps+=want;
    if(d<0)miss+=-d; else ph+=d;
  }
  TM+=miss;TP+=ph;TR+=reps;
  console.log(`  ${fam.padEnd(9)} n=${String(list.length).padStart(3)} reps=${String(reps).padStart(4)}  miss=${String(miss).padStart(3)}  phantom=${String(ph).padStart(3)}`);
}
console.log(`  TOTAL  miss=${TM}/${TR} (${(100*TM/TR).toFixed(2)}%)  phantom=${TP} (${(100*TP/TR).toFixed(2)}%)`);
