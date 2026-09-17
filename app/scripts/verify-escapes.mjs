// The escape hatches are the safety-critical path: every route out of a set
// must reach onFinish, because that is what silences the alarm.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { initCounter } = await import(path.join(ROOT, 'src/counter.js'));
const { occurrences, RING_BURST, DAYS_AHEAD, IOS_PENDING_CAP } = await import(path.join(ROOT, 'src/alarm.js'));

const HTML = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const IDS = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
const DT = 1000/60;
let pass=0, fail=0;
const check=(l,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${l}${x?'  '+x:''}`);};

function stub(luma){
  const rafQ=[]; let now=0; const els=new Map();
  const CTX=new Proxy({},{get:(t,k)=>{
    if(k==='canvas')return{width:600,height:168};
    if(k==='getImageData')return(x,y,w,h)=>{const v=Math.max(0,Math.min(255,luma.f()));
      const d=new Uint8ClampedArray(w*h*4);
      for(let i=0;i<w*h;i++){d[i*4]=v;d[i*4+1]=v;d[i*4+2]=v;d[i*4+3]=255;}return{data:d};};
    return ()=>{};}});
  const El=id=>{const c=new Set();return{id,textContent:'',disabled:false,offsetWidth:1,style:{},
    classList:{add:x=>c.add(x),remove:x=>c.delete(x),contains:x=>c.has(x),toggle:(x,o)=>{o?c.add(x):c.delete(x);}},
    _cls:c,appendChild(){},remove(){},insertBefore(){},get parentNode(){return{insertBefore(){}};},
    nextSibling:null,width:600,height:168,getContext:()=>CTX};};
  const doc={getElementById(id){if(!IDS.has(id)&&!els.has(id))return null;
    if(!els.has(id))els.set(id,El(id));return els.get(id);},createElement:()=>El('t'),addEventListener(){}};
  const v=doc.getElementById('cam'); v.videoWidth=640; v.play=()=>Promise.resolve();
  globalThis.document=doc; globalThis.location={search:''};
  globalThis.performance={now:()=>now};
  globalThis.requestAnimationFrame=cb=>{rafQ.push(cb);return rafQ.length;};
  globalThis.localStorage={getItem:()=>null,setItem(){}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,writable:true,
    value:{mediaDevices:{getUserMedia:()=>Promise.resolve({getTracks:()=>[]})}}});
  const w={};w.self=w;w.top=w;globalThis.window=w;globalThis.self=w;globalThis.top=w;
  return {doc,tick(ms){now+=ms;for(const cb of rafQ.splice(0,rafQ.length))cb(now);},now:()=>now};
}
async function boot(goal=5,flat=false){
  const luma={f:()=>128}; const H=stub(luma);
  let fin=null;
  const c=initCounter({goal,onFinish:(mode,count)=>{fin={mode,count};}});
  luma.f=()=>{const t=H.now();
    if(flat) return 128 + (Math.random()*0.4-0.2);
    if(t<6000){const s=t<900?-22*(1-t/900):0;return 128+s+22*Math.cos(2*Math.PI*t/3000);}
    return 128+12*Math.cos(2*Math.PI*(t-6000)/1600);};
  H.doc.getElementById('startBtn').onclick.call(H.doc.getElementById('startBtn'));
  for(let i=0;i<6;i++) await Promise.resolve();
  return {H,c,get fin(){return fin;}};
}
const run=(H,ms)=>{for(let i=0;i<ms/DT;i++) H.tick(DT);};
const on=(H,id)=>H.doc.getElementById(id)._cls.has('on');

console.log('== escape hatches (each must reach onFinish) ==');
let s=await boot(); run(s.H,9000);
s.H.doc.getElementById('notWorking').onclick();
check('sheet opens from the counting screen', on(s.H,'sheet'));
s.H.doc.getElementById('bail').onclick();
check('bail -> onFinish fires', !!s.fin, s.fin?`mode=${s.fin.mode}`:'NEVER FIRED');
check('bail -> done screen', on(s.H,'sDone'));

s=await boot(); run(s.H,9000);
s.H.doc.getElementById('toTimer').onclick();
run(s.H,31000);
check('30s timer -> onFinish fires', !!s.fin, s.fin?`mode=${s.fin.mode}`:'NEVER FIRED');

s=await boot(); run(s.H,2000);
s.H.doc.getElementById('skipCal').onclick();
run(s.H,31000);
check('skip calibration -> timer -> onFinish', !!s.fin && s.fin.mode==='timer');

s=await boot(); run(s.H,9000);
const pend=s.H.doc.getElementById; s.H.doc.getElementById('recal').onclick();
check('recalibrate returns to calibration', on(s.H,'sCal'));
run(s.H,7000);
check('recalibrate leads back to counting', on(s.H,'sCount'));

s=await boot(3); run(s.H,6200); run(s.H,20000);
check('completing the goal -> onFinish fires', !!s.fin, s.fin?`mode=${s.fin.mode} count=${s.fin.count}`:'NEVER FIRED');

s=await boot(5,true); run(s.H,6500);
check('flat signal refused at calibration (not silently counting)',
  String(s.H.doc.getElementById('calTitle').textContent).includes('enough movement'));

console.log('\n== alarm scheduling maths ==');
const times=occurrences('06:30', new Date('2026-03-01T22:00:00'));
check('schedules RING_BURST * DAYS_AHEAD notifications', times.length===RING_BURST*DAYS_AHEAD, `${times.length}`);
check('stays under the iOS 64-pending cap', times.length<IOS_PENDING_CAP, `${times.length} < ${IOS_PENDING_CAP}`);
check('every occurrence is in the future', times.every(t=>t>new Date('2026-03-01T22:00:00')));
check('first ring is the next 06:30', times[0].getHours()===6 && times[0].getMinutes()===30);
check('burst is spaced a minute apart', (times[1]-times[0])===60000);
check('bursts are strictly increasing', times.every((t,i)=>i===0||t>times[i-1]));
const past=occurrences('06:30', new Date('2026-03-01T07:00:00'));
check('an alarm time already passed today rolls to tomorrow',
  past[0].getDate()===2, past[0].toISOString());

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
