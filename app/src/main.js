import './styles.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { initCounter } from './counter.js';
import { loadSettings, saveSettings } from './storage.js';
import * as alarm from './alarm.js';
import * as alarmAudio from './alarmAudio.js';
import * as alarmKit from './alarmKit.js';

const $ = (id) => document.getElementById(id);
const isNative = Capacitor.isNativePlatform();

// The single alarm AlarmKit owns for this app. One recurring alarm covers
// every morning - see alarmKit.js and DawnAlarmKit.swift for why this is
// architecturally simpler than the legacy rolling-notification window.
const ALARMKIT_ID = 'dawn-daily';

// On-device testing found that swiping the full-screen alert away dismisses
// it as a system-level gesture that never reaches DawnAlarmStopIntent at all -
// no re-ring gets scheduled, silently defeating the whole point. Tapping the
// button reaches it reliably. This is the one place that can say so right on
// the alert itself, at the moment it actually matters.
function alarmKitLabel(goal){
  return goal + (goal === 1 ? ' push-up' : ' push-ups') + ' to turn it off - tap, don’t swipe';
}

// The one scheduleAlarm() call, built from current settings - used by the Arm
// button, by a settings change while armed, and by the auto-recovery path
// that notices the system alarm went missing. One place to build it means
// those three can never quietly drift apart.
async function scheduleAlarmKitNow(){
  const [hour, minute] = settings.time.split(':').map(Number);
  return alarmKit.scheduleAlarm({
    id: ALARMKIT_ID, hour, minute, repeatDays: [0,1,2,3,4,5,6],
    label: alarmKitLabel(settings.goal),
    sound: alarm.soundFile(settings.sound)
  });
}

// Next occurrence of hour:minute from now - today if it has not passed yet,
// tomorrow if it has. Used to show the REAL next ring time, read from the
// system alarm, rather than recomputed from saved settings that could have
// drifted from what is actually scheduled.
function nextOccurrence(hour, minute){
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d;
}

// The one thing that can make "armed" a lie: the system alarm itself goes
// missing (an OS quirk, anything) while settings still say armed. Checked on
// every launch and every foreground return - on its own, it tries to fix
// this immediately and silently; the user only sees anything if that retry
// also fails. Returns the system alarm's {hour, minute} if one exists
// (freshly rescheduled or not), or null if none could be made to exist.
async function findMyAlarmKitAlarm(){
  try { return ((await alarmKit.listAlarms()).alarms || []).find(a => a.id === ALARMKIT_ID) || null; }
  catch (e){ return null; }
}

async function ensureAlarmKitArmed(){
  if (!settings.armed || settings.alarmBackend !== 'alarmkit') return null;
  let mine = await findMyAlarmKitAlarm();
  if (mine){
    $('missingAlarmWarn').classList.add('hide');
    return mine;
  }
  try {
    await scheduleAlarmKitNow();
    $('missingAlarmWarn').classList.add('hide');
    return await findMyAlarmKitAlarm();
  } catch (e){
    $('missingAlarmWarn').classList.remove('hide');
    $('missingAlarmText').textContent = 'The alarm went missing from the system and could not be ' +
      'rescheduled automatically (' + e + '). Tap Re-arm, or check Settings → Dawn Alarm.';
    return null;
  }
}

// Closes the swipe-bypass gap: swiping the alert dismisses it as a system
// gesture that never reaches DawnAlarmStopIntent, so no flag ever records
// that the mission is unfinished. Deriving "owed" from the alarm's own
// scheduled time instead means opening the app any time after that time, by
// any means, still routes to push-ups - not just when Stop was tapped.
async function checkOwedByTime(mine){
  if (!mine || counter.isRunning()) return false;
  const now = new Date();
  const scheduled = new Date(now); scheduled.setHours(mine.hour, mine.minute, 0, 0);
  if (now < scheduled) return false;
  const todayKey = alarm.dayKey(now);
  if ((await alarm.satisfiedKey()) === todayKey) return false;
  await enterRing({ real: true, morning: todayKey });
  return true;
}

let settings = { time: '06:30', goal: 10, armed: false, alarmBackend: 'legacy' };
let counter = null;

// What the current ring is, if any. `real` distinguishes an actual alarm from
// a "Try it now" test: only a real ring can satisfy a morning, or a 06:15 test
// run would cancel the 06:30 alarm it was meant to rehearse.
let activeRing = null;

// Last state reported by the native audio plugin. Drives the armed-screen
// warning: an alarm that silently fell back to notifications is exactly the
// kind of failure this app keeps trying not to have.
let lastAudioState = null;

// ---------------------------------------------------------------------------
// Alarm sound.
// ---------------------------------------------------------------------------
// The ring screen plays the same sound the notification uses. Resolved against
// document.baseURI because the build uses base './'. Regenerate the files with
// scripts/make-sounds.py.
function alarmSrc(){
  return new URL(alarm.soundUrl(settings.sound), document.baseURI).href;
}
let audio = null, audioFor = null, preview = null, previewTimer = null;

// iOS will not start audio without a user gesture. Arming is a gesture, so we
// use it to unlock playback for the session; if the app was relaunched cold by
// the notification, the "Start push-ups" tap is the next gesture available.
function primeAudio(){
  if (audio && audioFor === settings.sound) return;
  audio = new Audio(alarmSrc());
  audioFor = settings.sound;
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 1.0;
  audio.play().then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => {});
}

function startRinging(){
  stopPreview();
  if (alarmAudio.isNativeAudio){
    // Native path: survives backgrounding and ignores the silent switch. Only
    // stopRinging() ends it - not a tap, not a swipe, not the app closing.
    alarmAudio.fireAlarm(alarm.soundFile(settings.sound),
                         (activeRing && activeRing.morning) || alarm.dayKey(new Date()));
    return;
  }
  if (!audio || audioFor !== settings.sound){
    audio = new Audio(alarmSrc());
    audioFor = settings.sound;
    audio.loop = true;
  }
  audio.currentTime = 0;
  audio.play().catch((err) => {
    const w = $('soundWarn');
    w.classList.remove('hide');
    w.textContent = (err && err.name === 'NotSupportedError')
      ? 'That sound file is missing — run scripts/make-sounds.py to regenerate it.'
      : 'iOS would not start the sound without a tap. The notification itself still made noise.';
  });
}

// The single choke point for silencing the alarm. Reached from onFinish (a
// completed set, the 30s timer, or a bail) and from the test-run back arrow -
// and from nowhere else.
function stopRinging(){
  try { if (audio){ audio.pause(); audio.currentTime = 0; } } catch (e){}
  if (alarmAudio.isNativeAudio) alarmAudio.stopAlarm();
}

// ---------------------------------------------------------------------------
// Keep the screen awake for a set. Screen Wake Lock is supported in iOS 16.4+.
// If this proves unreliable on device, swap in @capacitor-community/keep-awake
// (a one-line change in these two functions).
// ---------------------------------------------------------------------------
let wakeLock = null, wantAwake = false;

async function requestWakeLock(){
  wantAwake = true;
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e){ /* denied or unsupported - the set still works, the screen may dim */ }
}
function releaseWakeLock(){
  wantAwake = false;
  try { wakeLock && wakeLock.release(); } catch (e){}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (wantAwake && document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function showAlarmScreen(){
  releaseWakeLock();
  stopRinging();
  counter.reset();
  stopPreview();
  $('alarmTime').value = settings.time;
  renderSounds();
  $('goalVal').textContent = settings.goal;
  $('armBtn').textContent = settings.armed ? 'Disarm' : 'Arm the alarm';
  renderArmState();
  counter.show('alarm');
}

// ---------------------------------------------------------------------------
// Sound picker
// ---------------------------------------------------------------------------
function stopPreview(){
  if (previewTimer){ clearTimeout(previewTimer); previewTimer = null; }
  if (preview){ try { preview.pause(); } catch (e){} preview = null; }
  $('soundPreview').classList.remove('playing');
  $('soundPreview').textContent = 'Preview';
}

function renderSounds(){
  const wrap = $('soundChips');
  wrap.textContent = '';
  for (const s of alarm.SOUNDS){
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = s.label;
    b.setAttribute('aria-pressed', String(s.id === settings.sound));
    b.onclick = async () => {
      settings.sound = s.id;
      audio = null; audioFor = null;      // next ring rebuilds with the new file
      renderSounds();
      playPreview();                      // hear it immediately
      // Every pending notification carries its sound, so all of them have to be
      // rebuilt. arm() skips any morning already satisfied, so this cannot
      // resurrect one that has been dismissed.
      await persistAndMaybeReschedule();
    };
    wrap.appendChild(b);
  }
  $('soundNote').textContent = alarm.soundOf(settings.sound).note;
}

function playPreview(){
  stopPreview();
  preview = new Audio(alarmSrc());
  preview.loop = false;
  $('soundPreview').classList.add('playing');
  $('soundPreview').textContent = 'Stop';
  preview.play().catch(() => { stopPreview(); });
  preview.onended = stopPreview;
  // The files run 20s so they are long enough for a notification; a preview
  // only needs a few seconds of it.
  previewTimer = setTimeout(stopPreview, 6000);
}

// Keep the native scheduler pointed at the next ring. `built` is whatever
// arm()/topUp() returned, or null when topUp decided to leave things alone.
async function rescheduleNativeAlarm(built){
  if (!alarmAudio.isNativeAudio) return;
  if (built && built.first && built.mornings && built.mornings.length){
    await alarmAudio.scheduleAlarm(built.first.getTime(),
                                   alarm.soundFile(settings.sound),
                                   built.mornings[0].key);
  }
}

// The lapse warning is informational: tapping it must open the app, not start
// an alarm. Anything with kind 'ring' is a real ring and carries its morning.
function handleNotification(n){
  const extra = (n && n.extra) || {};
  if (extra.kind === 'warn'){
    showAlarmScreen();
    const w = $('armWarn');
    w.classList.remove('hide');
    w.textContent = 'This alarm was about to lapse. Opening the app has ' +
      're-armed it for another ' + alarm.DAYS_AHEAD + ' days.';
    return;
  }
  enterRing({ real: true, morning: extra.morning || alarm.dayKey(new Date()) });
}

// "Armed" on its own becomes a lie once the window runs out, so the date it
// runs out is always on screen next to it.
function renderArmedThrough(){
  const el = $('armThrough');
  if (!isNative){
    el.textContent = 'Nothing is scheduled in a browser. The iOS build arms ' +
      alarm.DAYS_AHEAD + ' mornings at a time.';
    return;
  }
  if (settings.alarmBackend === 'alarmkit'){
    // Read from the system alarm itself, not recomputed from saved settings -
    // those can say "armed" while the actual alarm is gone. Fire-and-forget,
    // same pattern as renderDebugState(): renderArmedThrough() is not async.
    el.textContent = 'Checking the system alarm…';
    (async () => {
      const mine = await findMyAlarmKitAlarm();
      if (mine){
        const next = nextOccurrence(mine.hour, mine.minute);
        el.textContent = 'Next ring: ' + next.toLocaleString([], {
          weekday: 'short', hour: 'numeric', minute: '2-digit'
        }) + '. Rings every day at this time until you disarm it.';
        $('missingAlarmWarn').classList.add('hide');
      } else {
        el.textContent = '';
        $('missingAlarmWarn').classList.remove('hide');
        $('missingAlarmText').textContent = 'No alarm exists in the system right now, even though ' +
          'this screen said armed. Tap Re-arm below.';
      }
    })();
    return;
  }
  const built = alarm.buildNotifications(settings.time, settings.goal, new Date(), null, settings.sound);
  if (!built.through){ el.textContent = ''; return; }
  const day = built.through.toLocaleDateString([], {
    weekday: 'long', month: 'short', day: 'numeric'
  });
  const left = Math.max(0, Math.round((built.through - Date.now()) / 86400000));
  el.textContent = 'Rings through ' + day + ' (' + left + ' more mornings), then ' +
    'stops until you open the app again.' +
    (built.warnAt ? ' You will be reminded ' + alarm.WARN_LEAD_DAYS + ' days before.' : '');
}

// On-screen stand-in for Safari's Web Inspector - same data dawnDebugState()
// exposes to the console, just visible without connecting a Mac at all.
// Fire-and-forget: renderArmState() itself is not async and is called from
// many sync contexts.
function renderDebugState(){
  const el = $('debugState');
  if (!el) return;
  // import.meta.env?.DEV is Vite's build-time flag: false in `vite build`
  // (what ships to the App Store), so this is compiled out of release builds
  // entirely - no flag or gesture can surface it there.
  if (!import.meta.env?.DEV || !isNative){ el.textContent = ''; return; }
  (async () => {
    try {
      const pending = await LocalNotifications.getPending();
      const ak = await alarmKit.listAlarms();
      const legacyIds = (pending.notifications || []).map(n => n.id);
      const dbg = ak.debug || {};
      el.textContent = 'backend: ' + settings.alarmBackend +
        '\nAlarmKit alarms: ' + JSON.stringify(ak.alarms) +
        '\nlegacy pending (' + legacyIds.length + '): ' + legacyIds.join(',') +
        '\nlast Stop intent ran at: ' + (dbg.lastStopIntentAt || '(never)') +
        '\nlast follow-up error: ' + (dbg.lastFollowUpError || '(none)') +
        '\nfollow-up alarm state: ' + (dbg.followUpAlarmState || '(unknown)');
    } catch (e){ el.textContent = 'debug state failed: ' + e; }
  })();
}

function renderArmState(){
  renderDebugState();
  const el = $('armState');
  if (!settings.armed){
    el.textContent = 'Not armed.';
    el.classList.remove('armed');
    $('armThrough').textContent = '';
    $('ringerNote').textContent = '';
    $('quitNote').textContent = '';
    $('audioWarn').classList.add('hide');
    $('missingAlarmWarn').classList.add('hide');
    return;
  }
  const [h, m] = settings.time.split(':').map(Number);
  const t = new Date(); t.setHours(h, m, 0, 0);
  const label = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.textContent = 'Armed for ' + label + ' — ' + settings.goal +
    (settings.goal === 1 ? ' push-up' : ' push-ups') + '.';
  el.classList.add('armed');
  renderArmedThrough();
  if (settings.alarmBackend === 'alarmkit'){
    // The ringer-silent-switch advisory does not apply (no notification
    // fallback to warn about - AlarmKit owns delivery entirely). Force-quit
    // is NOT asserted safe here: a real overnight failure happened after the
    // app was force-quit, and a quick direct retest rang fine, so the
    // evidence is genuinely mixed rather than reassuring. ensureAlarmKitArmed()
    // and the missing-alarm warning below are the actual mitigation - they
    // catch the symptom (the alarm is gone) regardless of the cause.
    $('ringerNote').textContent = '';
    $('quitNote').textContent = '';
    $('audioWarn').classList.add('hide');
    return;
  }
  // Permanent while armed. Deliberately not a dismissible toast: it has to
  // still be here later, when someone is working out why nothing rang.
  $('ringerNote').textContent = alarm.RINGER_ADVISORY;
  $('quitNote').textContent = alarmAudio.isNativeAudio ? alarm.FORCE_QUIT_ADVISORY : '';
  renderAudioHealth();
}

// The continuous alarm is the whole product. If the audio session is not
// actually up, or nothing is watching for the fire time, say so on the armed
// screen rather than letting it look armed and quietly fall back to beeps.
function renderAudioHealth(){
  const box = $('audioWarn');
  if (!alarmAudio.isNativeAudio || !settings.armed){
    box.classList.add('hide');
    return;
  }
  const st = lastAudioState;
  const healthy = !!(st && st.keepalive && st.monitoring && st.scheduledAt > 0);
  box.classList.toggle('hide', healthy);
  if (!healthy){
    const missing = [];
    if (!st) missing.push('no response from the audio plugin');
    else {
      if (!st.keepalive) missing.push('audio session not running');
      if (!st.monitoring) missing.push('no timer watching for the alarm');
      if (!(st.scheduledAt > 0)) missing.push('no fire time scheduled');
    }
    box.textContent = alarm.AUDIO_FAILED_ADVISORY + ' (' + missing.join('; ') + ')';
  }
}

async function enterRing({ real = false, morning = null } = {}){
  const key = morning || alarm.dayKey(new Date());
  const gate = alarm.shouldRing({
    setInProgress: counter.isRunning(),
    real,
    morning: key,
    satisfiedKey: isNative ? await alarm.satisfiedKey() : null
  });
  if (!gate.ring){
    // 'set-in-progress': a later burst arrived while they are actually doing
    // the reps - stay out of the way. 'already-satisfied': a notification from
    // a morning that is already done was tapped out of Notification Center.
    if (gate.reason === 'already-satisfied') showAlarmScreen();
    return;
  }
  activeRing = { real, morning: key };
  const showBack = alarm.backArrowVisible({ real });
  $('ringBack').classList.toggle('hide', !showBack);
  $('sRing').classList.toggle('hasBack', showBack);
  $('soundWarn').classList.add('hide');
  $('ringCount').textContent = settings.goal;
  counter.setGoal(settings.goal);
  counter.show('ring');
  requestWakeLock();
  startRinging();
}

// ---------------------------------------------------------------------------
// Alarm screen wiring
// ---------------------------------------------------------------------------
function wireUI(){
$('plus').onclick  = async () => {
  settings.goal = Math.min(50, settings.goal + 1);
  $('goalVal').textContent = settings.goal;
  await persistAndMaybeReschedule();
};
$('minus').onclick = async () => {
  settings.goal = Math.max(1, settings.goal - 1);
  $('goalVal').textContent = settings.goal;
  await persistAndMaybeReschedule();
};
$('alarmTime').onchange = async (e) => {
  settings.time = e.target.value || settings.time;
  await persistAndMaybeReschedule();
};

async function persistAndMaybeReschedule(){
  await saveSettings(settings);
  renderArmState();
  // An armed alarm whose time or goal just changed has to be rebuilt, or it
  // would still ring at the old time with the old number.
  if (!settings.armed || !isNative) return;
  if (settings.alarmBackend === 'alarmkit'){
    // scheduleAlarm replaces whatever is under this id rather than stacking.
    // A failure here must not be swallowed - it would otherwise look armed
    // with the old time/goal/sound while actually unchanged or (worse)
    // half-updated.
    try {
      await scheduleAlarmKitNow();
      $('missingAlarmWarn').classList.add('hide');
    } catch (e){
      $('missingAlarmWarn').classList.remove('hide');
      $('missingAlarmText').textContent = 'Could not update the alarm (' + e + '). Tap Re-arm to try again.';
    }
  } else {
    await alarm.arm(settings.time, settings.goal, settings.sound);
  }
}

$('armBtn').onclick = async () => {
  primeAudio();
  const warn = $('armWarn'), perm = $('permWarn');
  warn.classList.add('hide'); perm.classList.add('hide');

  if (settings.armed){
    // A ringing or owed morning must be pushed through the ring screen, not
    // silently turned off here. Checked again right at this exact point -
    // not just upstream in the foreground/cold-boot paths that normally
    // catch it - so Disarm cannot become a bypass no matter how this screen
    // was reached.
    if (activeRing && activeRing.real) return;
    if (settings.alarmBackend === 'alarmkit' &&
        await checkOwedByTime(await findMyAlarmKitAlarm())){
      return;
    }
    if (settings.alarmBackend === 'alarmkit'){
      await alarmKit.cancelAlarm(ALARMKIT_ID);
    } else {
      if (isNative) await alarm.disarm();
      await alarmAudio.clearScheduledAlarm();
      await alarmAudio.stopKeepalive();   // release the audio session
    }
    settings.armed = false;
    await saveSettings(settings);
    lastAudioState = null;
    showAlarmScreen();
    return;
  }

  if (!isNative){
    settings.armed = true;
    await saveSettings(settings);
    perm.classList.remove('hide');
    perm.textContent = 'Running in a browser, so nothing is actually scheduled. ' +
      'Use "Try it now" to walk the flow; the real alarm needs the iOS build.';
    showAlarmScreen();
    return;
  }

  // AlarmKit is the only alarm path now (minimum iOS is 26.1, so it is always
  // available) - requested fresh on every arm, not just once at launch,
  // since authorization can change in Settings between arms. There is no
  // silent fallback: either this succeeds and is armed, or it plainly does
  // not and is NOT armed. An alarm that looks armed but is not is exactly
  // the failure this app exists to prevent.
  const akStatus = (await alarmKit.requestAuthorization()).status;
  if (akStatus !== 'authorized'){
    settings.armed = false;
    await saveSettings(settings);
    warn.classList.remove('hide');
    warn.textContent = (akStatus === 'denied'
      ? 'Alarm permission is off for this app, so it cannot wake you. Turn it on in '
      : 'Alarm permission was not granted, so the alarm cannot be armed. Turn it on in ') +
      'iOS Settings → Dawn Alarm → Alarms, then arm it again. ' +
      'You can still use "Try it now" while the app is open.';
    renderArmState();
    return;
  }

  try {
    await scheduleAlarmKitNow();
  } catch (e){
    settings.armed = false;
    await saveSettings(settings);
    warn.classList.remove('hide');
    warn.textContent = 'Scheduling failed (' + e + '). The alarm is NOT armed - ' +
      'try again, or check Settings → Dawn Alarm → Alarms.';
    renderArmState();
    return;
  }

  settings.armed = true;
  settings.alarmBackend = 'alarmkit';
  await saveSettings(settings);
  renderArmState();
  perm.classList.remove('hide');
  perm.textContent = 'Armed with AlarmKit: the system owns this alarm the same way it owns ' +
    'Clock app alarms. Tap the button when it rings - swiping the alert away does not turn ' +
    'it off, it will just ring again.';
  $('armBtn').textContent = 'Disarm';
};

$('rearmBtn').onclick = async () => {
  $('rearmBtn').disabled = true;
  try {
    await scheduleAlarmKitNow();
    $('missingAlarmWarn').classList.add('hide');
  } catch (e){
    $('missingAlarmText').textContent = 'Re-arm failed (' + e + '). Check Settings → Dawn Alarm → Alarms.';
  }
  $('rearmBtn').disabled = false;
  renderArmState();
};

$('soundPreview').onclick = () => {
  if (preview) { stopPreview(); return; }
  primeAudio();          // the tap doubles as the gesture that unlocks audio
  playPreview();
};

$('testBtn').onclick = () => { primeAudio(); enterRing({ real: false }); };

// Never trap someone on the ringing screen either: the same escape sheet the
// counting screen uses is reachable before a single rep is attempted.
$('ringEscape').onclick = () => { $('sheet').classList.add('on'); };

// Back out of a TEST run only (the arrow is not rendered for a real alarm).
// This deliberately does NOT go through onFinish: abandoning a rehearsal must
// not satisfy the morning or cancel a single real scheduled notification.
$('ringBack').onclick = () => {
  if (activeRing && activeRing.real) return;   // belt and braces
  activeRing = null;
  showAlarmScreen();
};

$('againBtn').onclick = () => { showAlarmScreen(); };

// The ?debug=1 overlay has no way in on a packaged app (no query string), so
// five taps on the heading toggles the persisted flag instead. Deliberately
// undiscoverable rather than a visible switch on a 6am alarm screen.
// Not wired at all in a release build (see import.meta.env?.DEV above) - the
// flag it toggles is ignored there anyway, but there is no reason to leave
// dead debug chrome reachable in the shipped app.
if (import.meta.env?.DEV){
  let taps = 0, tapT = 0;
  $('sAlarm').querySelector('h1').onclick = () => {
    const now = Date.now();
    taps = (now - tapT < 600) ? taps + 1 : 1;
    tapT = now;
    if (taps < 5) return;
    taps = 0;
    let on = false;
    try {
      on = localStorage.getItem('dawn.debug') === '1';
      localStorage.setItem('dawn.debug', on ? '0' : '1');
    } catch (e){ return; }
    location.reload();
  };
}
}

// ---------------------------------------------------------------------------
// Boot. Kept inside a function rather than using top-level await, so the
// bundle stays within the es2020 target WKWebView is guaranteed to handle.
// ---------------------------------------------------------------------------
async function boot(){
  settings = await loadSettings();

  // The counter is initialised once: it owns a requestAnimationFrame chain, so
  // re-initialising per alarm would stack loops (a bug the prototype hit and
  // fixed). The per-set goal is pushed in with setGoal instead.
  counter = initCounter({
    goal: settings.goal,
    onFinish: async () => {
      stopRinging();
      releaseWakeLock();
      $('againBtn').textContent = 'Back to the alarm';
      // A set is finished. This is the ONLY thing that satisfies a morning:
      // reps completed, the 30-second timer run down, or a deliberate bail.
      // The escape hatches are legitimate exits and count as satisfied; a
      // notification tap, a swipe, or opening and abandoning the app do not.
      const ring = activeRing;
      activeRing = null;
      if (!isNative || !ring || !ring.real) return;
      if (settings.alarmBackend === 'alarmkit'){
        // markSatisfied records today as done - checkOwedByTime() needs this
        // so reopening the app later today does not re-route to push-ups
        // after they are actually finished. completeMission() cancels just
        // the short follow-up Stop may have armed; tomorrow's occurrence on
        // the recurring alarm itself is untouched.
        await alarm.markSatisfied(ring.morning);
        await alarmKit.completeMission();
        renderArmState();
        return;
      }
      await alarm.markSatisfied(ring.morning);
      // Now this morning is settled, refill the window to its full depth and
      // hand the NEXT morning's fire time to the native scheduler.
      if (settings.armed){
        const next = await alarm.topUp(settings.time, settings.goal, settings.sound);
        await rescheduleNativeAlarm(next);
      }
      renderArmState();
    }
  });

  wireUI();

  if (isNative){
    // Tapped the notification (app backgrounded or cold-launched).
    LocalNotifications.addListener('localNotificationActionPerformed', (ev) => {
      handleNotification(ev && ev.notification);
    });
    // Fired while the app was already open and in front.
    LocalNotifications.addListener('localNotificationReceived', (n) => {
      handleNotification(n);
    });

    App.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive) return;
      if (settings.alarmBackend === 'alarmkit'){
        // Tapping the system alert's one button is what brings the app
        // forward in the first place - this is the first chance JS gets to
        // act on it. ensureAlarmKitArmed() first: every foreground return is
        // a chance to notice and fix a missing alarm before it matters again.
        const mine = await ensureAlarmKitArmed();
        const intent = await alarmKit.consumePushupIntent();
        if (intent.wants && !counter.isRunning()){
          await enterRing({ real: true, morning: intent.morning || alarm.dayKey(new Date()) });
        } else {
          await checkOwedByTime(mine);
        }
        renderArmState();
        return;
      }
      if (settings.armed){
        const next = await alarm.topUp(settings.time, settings.goal, settings.sound);
        await rescheduleNativeAlarm(next);
      }
      // The native side may have started ringing while we were backgrounded.
      // Coming forward is the first chance JS gets to show the ring screen.
      const st = await alarmAudio.getState();
      lastAudioState = st;
      if (st && st.ringing && !counter.isRunning()){
        await enterRing({ real: true, morning: st.morning || alarm.dayKey(new Date()) });
      }
      renderArmState();
    });

    if (settings.armed && settings.alarmBackend !== 'alarmkit'){
      await alarm.topUp(settings.time, settings.goal, settings.sound);
    }
  }

  // Ask the native side FIRST. showAlarmScreen() calls stopRinging(), so
  // painting it before this check would silence an alarm that is ringing right
  // now, then immediately restart it.
  let resumed = false;
  if (settings.alarmBackend === 'alarmkit'){
    // A cold launch here usually means the system alert's button launched
    // the app - there is no "ringing right now" native state to query first,
    // AlarmKit owns that entirely; just consume the signal it left behind.
    // ensureAlarmKitArmed() first: a cold launch (reinstall, force-quit
    // recovery, just opening the app) is exactly when a missing alarm should
    // be noticed and fixed, not left silently broken until the next morning.
    const mine = await ensureAlarmKitArmed();
    const intent = await alarmKit.consumePushupIntent();
    if (intent.wants){
      await enterRing({ real: true, morning: intent.morning || alarm.dayKey(new Date()) });
      resumed = counter.show && activeRing !== null;
    } else {
      resumed = await checkOwedByTime(mine);
    }
  } else if (alarmAudio.isNativeAudio){
    const st = await alarmAudio.getState();
    lastAudioState = st;
    // st.ringing: the native timer fired while we were backgrounded and it is
    // sounding right now. wasRingingAtLaunch: the process died mid-ring and
    // came back. Either way enterRing() is the gate, so the satisfied-morning
    // record still decides and a completed morning stays silent.
    if (st && (st.ringing || st.wasRingingAtLaunch)){
      await enterRing({ real: true, morning: st.morning || alarm.dayKey(new Date()) });
      resumed = counter.show && activeRing !== null;
    } else if (settings.armed && !st.keepalive){
      // Armed, but the session died with the process. Rebuild it and re-hand
      // the fire time over, or the continuous alarm is quietly gone.
      lastAudioState = await alarmAudio.startKeepalive();
      const next = await alarm.topUp(settings.time, settings.goal, settings.sound);
      await rescheduleNativeAlarm(next);
    }
  }
  if (!resumed) showAlarmScreen();

  // Diagnostic only, debug mode, native - never shipped as reachable surface
  // otherwise. Run `await dawnDebugState()` from Safari's Web Inspector to see
  // which backend actually has something scheduled, rather than guessing from
  // symptoms alone.
  if (isNative){
    try {
      if (localStorage.getItem('dawn.debug') === '1'){
        window.dawnDebugState = async () => {
          const pending = await LocalNotifications.getPending();
          const ak = await alarmKit.listAlarms();
          return {
            settings,
            legacyPendingCount: (pending.notifications || []).length,
            legacyPendingIds: (pending.notifications || []).map(n => n.id),
            alarmKitAlarms: ak.alarms
          };
        };
      }
    } catch (e){}
  }
}

boot();
