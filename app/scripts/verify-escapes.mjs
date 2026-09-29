// The escape hatches are the safety-critical path: every route out of a set
// must reach onFinish, because that is what silences the alarm.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { initCounter } = await import(path.join(ROOT, 'src/counter.js'));
const A = await import(path.join(ROOT, 'src/alarm.js'));
const { RING_BURST, BURST_GAP_MIN, DAYS_AHEAD, IOS_PENDING_CAP, RESERVED_SLOTS,
        WARN_LEAD_DAYS, WARN_HOUR, RING_GRACE_MIN,
        plan, buildNotifications, shouldRing, inRingWindow, dayKey,
        armedThrough, slotsUsed, backArrowVisible, RINGER_ADVISORY,
        SOUNDS, DEFAULT_SOUND, soundFile, soundUrl, soundOf, isSound,
        FORCE_QUIT_ADVISORY } = A;

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

console.log('\n== ring screen back arrow: test runs only ==');
check('a test run offers a way back to alarm setup',
  backArrowVisible({ real: false }) === true);
check('a REAL alarm offers no back arrow (the screen is the dismissal gate)',
  backArrowVisible({ real: true }) === false);

// The arrow lives inside #sRing, so the .screen display toggle hides it on
// every other screen without any JavaScript having to remember to.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ring = html.slice(html.indexOf('id="sRing"'), html.indexOf('id="sCal"'));
check('the back arrow is inside the ring screen', ring.includes('id="ringBack"'));
check('it ships hidden by default', /id="ringBack"[^>]*class="[^"]*hide|class="[^"]*hide[^"]*"[^>]*id="ringBack"/.test(ring)
  || /<button[^>]*class="backArrow hide"[^>]*id="ringBack"/.test(ring));
check('it has an accessible label', ring.includes('aria-label="Back to alarm setup"'));
check('the real-alarm escape hatch is still on the ring screen too',
  ring.includes('id="ringEscape"'));

// Backing out of a rehearsal must not touch the real schedule. Rather than
// trust the comment, assert it structurally: satisfaction happens in exactly
// one place, and the back handler is not it.
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
check('markSatisfied is called from exactly one place',
  (main.match(/alarm\.markSatisfied\(/g) || []).length === 1);
const onFinishBlock = main.slice(main.indexOf('onFinish: async'), main.indexOf('wireUI();'));
check('...and that place is onFinish', onFinishBlock.includes('alarm.markSatisfied('));
const backBlock = main.slice(main.indexOf("$('ringBack').onclick"),
  main.indexOf("$('againBtn').onclick"));
for (const forbidden of ['markSatisfied', 'saveSatisfied', 'alarm.disarm', 'alarm.arm(', 'LocalNotifications']){
  check(`the back handler never calls ${forbidden}`, !backBlock.includes(forbidden));
}
check('the back handler refuses to run for a real ring',
  /activeRing && activeRing\.real/.test(backBlock));
// The arrow is fixed to the viewport corner, so the ring screen needs matching
// clearance or it lands on the heading. The two must always toggle together.
check('the clearance class toggles with the arrow',
  /classList\.toggle\('hasBack', showBack\)/.test(main) &&
  /classList\.toggle\('hide', !showBack\)/.test(main));
check('the clearance rule exists in the generated CSS',
  fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8').includes('#sRing.hasBack'));

console.log('\n== ringer advisory (no reliable silent-switch detection exists) ==');
check('an advisory exists', typeof RINGER_ADVISORY === 'string' && RINGER_ADVISORY.length > 40);
check('it names the silent switch', /silent switch/i.test(RINGER_ADVISORY));
check('it names the volume', /volume/i.test(RINGER_ADVISORY));
check('it does not claim to have checked the ringer',
  !/(your ringer is|currently (on|off)|detected)/i.test(RINGER_ADVISORY));
const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('the advisory has a permanent slot on the alarm screen', idx.includes('id="ringerNote"'));
check('it is not a dismissible toast (nothing can hide it)',
  !/ringerNote[^\n]*(hide|dismiss|close)/i.test(main) &&
  !/(hide|dismiss|close)[^\n]*ringerNote/i.test(main));
check('it is shown whenever the alarm is armed',
  /\$\('ringerNote'\)\.textContent = alarm\.RINGER_ADVISORY/.test(main));
check('and cleared when disarmed', /\$\('ringerNote'\)\.textContent = ''/.test(main));
// Arming a silent alarm is allowed; being surprised by it is not.
const armBlock = main.slice(main.indexOf("$('armBtn').onclick"), main.indexOf("$('testBtn').onclick"));
check('the advisory never blocks arming', !armBlock.includes('RINGER_ADVISORY'));

console.log('\n== alarm sounds ==');
check('there are 4-6 options', SOUNDS.length >= 4 && SOUNDS.length <= 6, `${SOUNDS.length}`);
check('ids are unique', new Set(SOUNDS.map(s => s.id)).size === SOUNDS.length);
check('each has a label and a description',
  SOUNDS.every(s => s.label && s.note && s.note.length > 8));
check('the default is one of them', isSound(DEFAULT_SOUND));
check('an unknown id falls back rather than throwing', soundOf('nope').id === DEFAULT_SOUND);

// iOS resolves a notification sound at the BUNDLE ROOT. A path with a
// directory in it silently falls back to the default sound.
check('soundFile() is a bare filename, no directory',
  SOUNDS.every(s => !soundFile(s.id).includes('/')));
check('soundFile() is a .wav', SOUNDS.every(s => soundFile(s.id).endsWith('.wav')));
check('soundUrl() is relative (the build uses base ./)',
  SOUNDS.every(s => !soundUrl(s.id).startsWith('/')));

// Every sound must exist in BOTH places, and satisfy Apple's format rules.
function wavInfo(p){
  const b = fs.readFileSync(p);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  const fmt = b.indexOf('fmt ', 0, 'latin1');
  const audioFormat = b.readUInt16LE(fmt + 8);
  const channels = b.readUInt16LE(fmt + 10);
  const rate = b.readUInt32LE(fmt + 12);
  const bits = b.readUInt16LE(fmt + 22);
  const data = b.indexOf('data', fmt, 'latin1');
  const bytes = b.readUInt32LE(data + 4);
  // Peak and RMS straight off the samples. The spectral and LUFS checks that
  // actually caught the "inaudible on a phone speaker" bug live in
  // scripts/verify-sounds.py; these are the cheap ones worth having here too.
  let peak = 0, sumsq = 0, n = 0;
  for (let i = data + 8; i + 1 < data + 8 + bytes && i + 1 < b.length; i += 2){
    const v = b.readInt16LE(i) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumsq += v * v; n++;
  }
  const dbfs = (v) => (v > 1e-12 ? 20 * Math.log10(v) : -999);
  return { audioFormat, channels, rate, bits,
           seconds: bytes / (rate * channels * bits / 8),
           peakDb: dbfs(peak), rmsDb: dbfs(Math.sqrt(sumsq / Math.max(1, n))) };
}
for (const s of SOUNDS){
  for (const [where, p] of [['web', path.join(ROOT, 'public/sounds', s.id + '.wav')],
                            ['bundle', path.join(ROOT, 'ios/App/App', s.id + '.wav')]]){
    if (!fs.existsSync(p)){ check(`${s.id} exists (${where})`, false, p); continue; }
    const w = wavInfo(p);
    check(`${s.id} (${where}) is linear-PCM wav under 30s`,
      !!w && w.audioFormat === 1 && w.bits === 16 && w.seconds < 30,
      w ? `${w.seconds.toFixed(1)}s ${w.bits}-bit fmt=${w.audioFormat}` : 'unreadable');
    // Loud, but never at full scale. -0.3 dBFS is the target.
    check(`${s.id} (${where}) peaks near full scale without clipping`,
      !!w && w.peakDb >= -1.0 && w.peakDb <= -0.1, w ? `${w.peakDb.toFixed(2)} dBFS` : '');
    check(`${s.id} (${where}) is not quiet`,
      !!w && w.rmsDb >= -18.0, w ? `RMS ${w.rmsDb.toFixed(1)} dBFS (floor -18)` : '');
  }
}
check('the generator is committed', fs.existsSync(path.join(ROOT, 'scripts/make-sounds.py')));
const gen = fs.readFileSync(path.join(ROOT, 'scripts/make-sounds.py'), 'utf8');
// The first set was inaudible on a phone because the energy sat below 500 Hz.
// These assert the fixes for that are still in the generator at all; the
// acoustic proof is scripts/verify-sounds.py.
check('the generator weights partials toward the speaker band', /def voice_gain/.test(gen));
check('...high-passes what the speaker cannot reproduce', /HP_HZ\s*=\s*\d/.test(gen));
check('...compresses and limits to raise the average', /def compress/.test(gen) && /def soft_limit/.test(gen));
check('...normalises peaks to about -0.3 dBFS', /TARGET_PEAK_DB\s*=\s*-0\.3/.test(gen));
check('...and escalates within the file', /def escalate/.test(gen));
check('the keepalive loop skips mastering (it must stay inaudible)',
  /if name != 'keepalive':\s*\n\s*samples = master/.test(gen));
check('the acoustic verifier is committed',
  fs.existsSync(path.join(ROOT, 'scripts/verify-sounds.py')));
check('the analyser is committed',
  fs.existsSync(path.join(ROOT, 'scripts/analyse-sounds.py')));
check('the iOS target script is committed', fs.existsSync(path.join(ROOT, 'scripts/add-ios-sounds.cjs')));

console.log('\n== changing the sound rebuilds every pending notification ==');
const quiet = buildNotifications('06:30', 10, EVE, null, 'dawn');
const loud  = buildNotifications('06:30', 10, EVE, null, 'reveille');
check('every ring carries the chosen sound',
  quiet.rings.every(r => r.sound === 'dawn.wav'), `${quiet.rings.length} rings`);
check('...and changing it changes all of them, not just the next',
  loud.rings.length === quiet.rings.length && loud.rings.every(r => r.sound === 'reveille.wav'),
  `${loud.rings.length} rings rebuilt`);
check('the lapse warning stays silent whatever is chosen',
  !loud.notifications.find(n => n.extra.kind === 'warn').sound);

// The exact bug class fixed last round: a rebuild must not resurrect a morning
// already dismissed. Changing the sound IS a rebuild.
const afterReps = buildNotifications('06:30', 10, new Date('2026-03-01T06:40:00'),
                                     '2026-03-01', 'reveille');
check('a sound change cannot resurrect a satisfied morning',
  afterReps.rings.every(r => r.extra.morning !== '2026-03-01'));
check('...while still re-sounding every other morning',
  afterReps.rings.length > 0 && afterReps.rings.every(r => r.sound === 'reveille.wav'));
check('arm() reads the satisfied morning before rebuilding',
  /loadSatisfied\(\)[\s\S]{0,200}buildNotifications/.test(
    fs.readFileSync(path.join(ROOT, 'src/alarm.js'), 'utf8')));

console.log('\n== the picker ==');
check('the picker is on the alarm screen', idx.includes('id="soundChips"'));
check('it has a preview control', idx.includes('id="soundPreview"'));
check('the choice is persisted with the other settings',
  fs.readFileSync(path.join(ROOT, 'src/storage.js'), 'utf8').includes("sound: 'chime'"));
check('choosing a sound re-schedules', /settings\.sound = s\.id[\s\S]{0,400}persistAndMaybeReschedule/.test(main));
check('the ring screen plays the chosen sound too', /alarm\.soundUrl\(settings\.sound\)/.test(main));
check('preview stops before a real ring starts', /function startRinging[\s\S]{0,120}stopPreview\(\)/.test(main));

console.log('\n== continuous audio alarm ==');
const swift = fs.readFileSync(path.join(ROOT, 'ios/App/App/DawnAlarmAudio.swift'), 'utf8');
const plist = fs.readFileSync(path.join(ROOT, 'ios/App/App/Info.plist'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'src/alarmAudio.js'), 'utf8');

// Parse the array rather than pattern-matching across it: there is an
// explanatory comment in between, and distance regexes are how you get a test
// that fails on a comment edit.
const bgArray = (plist.match(/<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || '';
check('UIBackgroundModes declares audio', /<string>audio<\/string>/.test(bgArray),
  `modes: ${(bgArray.match(/<string>([^<]+)<\/string>/g) || []).join(',') || 'none'}`);
check('the session uses .playback (ignores the silent switch)',
  /setCategory\(\.playback/.test(swift));
check('keepalive mixes with other audio (does not stop a podcast)',
  /mixWithOthers/.test(swift));
check('the alarm does NOT mix - it takes the session over',
  /activateForAlarm[\s\S]{0,300}options: \[\]\)/.test(swift));
check('the alarm loops forever (numberOfLoops = -1)', /numberOfLoops = loops/.test(swift) && /loops: -1/.test(swift));
check('the keepalive loop is silent (volume 0)', /keepalive\.wav", volume: 0\.0/.test(swift));
check('a near-silent keepalive file is generated',
  fs.existsSync(path.join(ROOT, 'ios/App/App/keepalive.wav')));

console.log('\n-- the three ways audio dies on its own --');
check('interruptions are observed (call, Siri)', /interruptionNotification/.test(swift));
check('...and the alarm resumes afterwards',
  /case \.ended:[\s\S]{0,400}alarmPlayer\?\.play\(\)/.test(swift));
check('route changes are observed (headphones out)', /routeChangeNotification/.test(swift));
check('...and it keeps ringing rather than pausing',
  /oldDeviceUnavailable[\s\S]{0,300}play\(\)/.test(swift));
check('media-services reset is handled', /mediaServicesWereResetNotification/.test(swift));
check('ringing state is persisted for relaunch', /UserDefaults[\s\S]{0,200}kRinging/.test(swift));

console.log('\n-- the satisfied morning still decides, not the audio --');
check('the plugin does not resume on its own',
  /restoreAfterLaunch[\s\S]{0,300}wasRingingAtLaunch = UserDefaults/.test(swift) &&
  !/restoreAfterLaunch[\s\S]{0,300}fireAlarm\(/.test(swift));
check('relaunch resume goes through enterRing (which gates on satisfied)',
  /wasRingingAtLaunch[\s\S]{0,200}enterRing\(\{ real: true/.test(main));
check('firing is only reachable from startRinging',
  (main.match(/alarmAudio\.fireAlarm\(/g) || []).length === 1);
// Find startRinging()'s single call site and name the function it sits in,
// rather than guessing at a character distance.
const callLine = main.split('\n').findIndex(l => /^\s*startRinging\(\);/.test(l));
const enclosing = main.split('\n').slice(0, callLine + 1)
  .filter(l => /^(async )?function \w+/.test(l)).pop() || '';
check('startRinging has exactly one call site',
  (main.match(/^\s*startRinging\(\);/gm) || []).length === 1);
check('...and it is inside enterRing (so the satisfied gate always runs first)',
  /function enterRing\b/.test(enclosing), enclosing.trim().slice(0, 60));
check('stopping is only reachable from stopRinging',
  (main.match(/alarmAudio\.stopAlarm\(/g) || []).length === 1);
check('onFinish stops the audio', /onFinish[\s\S]{0,300}stopRinging\(\)/.test(main));
check('the test-run back arrow stops the audio too',
  /ringBack'\)\.onclick[\s\S]{0,300}showAlarmScreen\(\)/.test(main) &&
  /showAlarmScreen[\s\S]{0,200}stopRinging\(\)/.test(main));
check('keepalive starts on arm and stops on disarm',
  /alarmAudio\.startKeepalive\(\)/.test(main) && /alarmAudio\.stopKeepalive\(\)/.test(main));

console.log('\n-- degrading safely --');
check('every native call is wrapped so a missing plugin cannot break the app',
  /try \{ return \(await Native\[name\]/.test(bridge) && /catch \(e\)/.test(bridge));
check('the web build gets a no-op stub', /webStub/.test(bridge));
check('notifications are kept as a fallback, not replaced',
  /RING_BURST/.test(fs.readFileSync(path.join(ROOT, 'src/alarm.js'), 'utf8')));
check('the force-quit limitation is stated in the UI',
  typeof FORCE_QUIT_ADVISORY === 'string' && /swipe/i.test(FORCE_QUIT_ADVISORY));
check('...and shown on the armed state', /quitNote'\)\.textContent = alarmAudio\.isNativeAudio/.test(main));
check('the ringer advisory no longer claims the silent switch wins',
  !/silent switch and the volume still win/.test(RINGER_ADVISORY));
check('...but still warns the notification fallback obeys it',
  /notifications still obey/i.test(RINGER_ADVISORY));

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
