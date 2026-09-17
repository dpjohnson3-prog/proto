// The escape hatches are the safety-critical path: every route out of a set
// must reach onFinish, because that is what silences the alarm.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { initCounter } = await import(path.join(ROOT, 'src/counter.js'));
const A = await import(path.join(ROOT, 'src/alarm.js'));
const { RING_BURST, BURST_GAP_MIN, DAYS_AHEAD, IOS_PENDING_CAP, RESERVED_SLOTS,
        WARN_LEAD_DAYS, WARN_HOUR, RING_GRACE_MIN,
        plan, buildNotifications, shouldRing, inRingWindow, dayKey,
        armedThrough, slotsUsed } = A;

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

console.log('\n== slot budget (BUG 1: the alarm must not expire silently) ==');
const EVE = new Date('2026-03-01T22:00:00');   // before the next 06:30
const built = buildNotifications('06:30', 10, EVE, null);
check('total pending stays under the iOS 64 cap',
  built.notifications.length <= IOS_PENDING_CAP, `${built.notifications.length} <= ${IOS_PENDING_CAP}`);
check('slotsUsed() agrees with what is actually built',
  slotsUsed() === built.notifications.length, `${slotsUsed()} vs ${built.notifications.length}`);
check('budget leaves headroom (not scraping the cap)',
  IOS_PENDING_CAP - built.notifications.length >= 5,
  `${IOS_PENDING_CAP - built.notifications.length} slots spare`);
check('rings = RING_BURST * DAYS_AHEAD',
  built.rings.length === RING_BURST * DAYS_AHEAD, `${built.rings.length}`);
check('exactly one lapse warning is scheduled',
  built.notifications.filter(n => n.extra.kind === 'warn').length === 1);
check('ring coverage is longer than the old 3 minutes',
  (RING_BURST - 1) * BURST_GAP_MIN >= 7, `${(RING_BURST-1)*BURST_GAP_MIN} min`);

const warn = built.notifications.find(n => n.extra.kind === 'warn');
check('warning fires before the window ends', warn.schedule.at < built.through);
// What matters is not elapsed hours but how many mornings still ring after the
// warning lands - that is the slack the user actually gets to act in.
const morningsAfterWarn = new Set(
  built.rings.filter(r => r.schedule.at > warn.schedule.at).map(r => r.extra.morning));
check('WARN_LEAD_DAYS mornings still ring after the warning',
  morningsAfterWarn.size === WARN_LEAD_DAYS, `${morningsAfterWarn.size} mornings of slack`);
check('warning lands WARN_LEAD_DAYS calendar days before the last morning',
  (new Date(built.through) - new Date(dayKey(warn.schedule.at))) / 86400000 > WARN_LEAD_DAYS - 1,
  `warn ${dayKey(warn.schedule.at)} -> last ${dayKey(built.through)}`);
check('warning fires at WARN_HOUR, when someone can act',
  warn.schedule.at.getHours() === WARN_HOUR);
check('warning id is outside the ring id range (never treated as a ring)',
  built.rings.every(r => r.id !== warn.id));
check('warning is not time-sensitive (it is not an alarm)',
  warn.interruptionLevel !== 'timeSensitive');
check('warning carries no alarm sound', !warn.sound);

console.log('\n== scheduling maths ==');
const times = built.rings.map(r => r.schedule.at);
check('every ring is in the future', times.every(t => t > EVE));
check('rings are strictly increasing', times.every((t, i) => i === 0 || t > times[i-1]));
check('first ring is the next 06:30',
  times[0].getHours() === 6 && times[0].getMinutes() === 30);
check('burst spacing is BURST_GAP_MIN',
  (times[1] - times[0]) === BURST_GAP_MIN * 60000);
check('armedThrough is the last burst of the last morning',
  armedThrough(built.mornings).getTime() === times[times.length-1].getTime());
const passed = buildNotifications('06:30', 10, new Date('2026-03-01T07:00:00'), null);
check('an alarm time already passed today rolls to tomorrow',
  passed.rings[0].schedule.at.getDate() === 2, passed.rings[0].schedule.at.toISOString());
check('every ring carries the morning it belongs to',
  built.rings.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.extra.morning)));
const byMorning = {};
for (const r of built.rings) byMorning[r.extra.morning] = (byMorning[r.extra.morning]||0)+1;
check('each morning gets exactly RING_BURST rings',
  Object.values(byMorning).every(v => v === RING_BURST), JSON.stringify(Object.values(byMorning)));
check('the window spans DAYS_AHEAD distinct mornings',
  Object.keys(byMorning).length === DAYS_AHEAD, `${Object.keys(byMorning).length}`);

console.log('\n== BUG 2: only a completed set satisfies a morning ==');
const TODAY = dayKey(EVE);
check('a real ring is blocked while a set is in progress',
  shouldRing({ setInProgress: true, real: true, morning: TODAY, satisfiedKey: null }).reason === 'set-in-progress');
check('a later burst cannot yank you out of the set that dismisses it',
  !shouldRing({ setInProgress: true, real: true, morning: TODAY, satisfiedKey: null }).ring);
check('a real ring for an already-satisfied morning is blocked',
  shouldRing({ setInProgress: false, real: true, morning: TODAY, satisfiedKey: TODAY }).reason === 'already-satisfied');
check('a real ring for an UNsatisfied morning rings',
  shouldRing({ setInProgress: false, real: true, morning: TODAY, satisfiedKey: '2026-02-28' }).ring);
check('yesterday being satisfied does not suppress today',
  shouldRing({ setInProgress: false, real: true, morning: TODAY, satisfiedKey: '2026-02-28' }).ring);
check('a test run still works after the morning is satisfied',
  shouldRing({ setInProgress: false, real: false, morning: TODAY, satisfiedKey: TODAY }).ring);

const sat = buildNotifications('06:30', 10, new Date('2026-03-01T05:00:00'), '2026-03-01');
check('a satisfied morning is not rescheduled by a rebuild',
  sat.rings.every(r => r.extra.morning !== '2026-03-01'));
check('...while later mornings still are',
  sat.rings.some(r => r.extra.morning === '2026-03-02'));
check('a rebuild mid-morning cannot resurrect a satisfied ring',
  buildNotifications('06:30', 10, new Date('2026-03-01T06:31:00'), '2026-03-01')
    .rings.every(r => r.extra.morning !== '2026-03-01'));
check('an UNsatisfied morning IS kept by a mid-ring rebuild',
  buildNotifications('06:30', 10, new Date('2026-03-01T06:31:00'), null)
    .rings.some(r => r.extra.morning === '2026-03-01'));

// markSatisfied cancels by exact morning match; this is that predicate.
const recs = built.rings.map(r => ({ id: r.id, at: r.extra.at, morning: r.extra.morning }));
const firstKey = recs[0].morning;
check('cancelling a morning selects exactly its own bursts',
  recs.filter(e => e.morning === firstKey).length === RING_BURST);
check('cancelling a morning leaves every other morning intact',
  recs.filter(e => e.morning !== firstKey).length === RING_BURST * (DAYS_AHEAD - 1));

console.log('\n== top-up guard (must not cancel notifications about to fire) ==');
check('inRingWindow is true at the first burst',
  inRingWindow('06:30', new Date('2026-03-01T06:30:10')));
check('inRingWindow is true mid-burst',
  inRingWindow('06:30', new Date('2026-03-01T06:35:00')));
check('inRingWindow covers the grace period for a slow set',
  inRingWindow('06:30', new Date('2026-03-01T07:05:00')));
check('inRingWindow is false before the alarm',
  !inRingWindow('06:30', new Date('2026-03-01T06:29:00')));
check('inRingWindow is false once the grace has run out',
  !inRingWindow('06:30', new Date('2026-03-01T08:30:00')));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
