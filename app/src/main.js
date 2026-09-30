import './styles.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { initCounter } from './counter.js';
import { loadSettings, saveSettings } from './storage.js';
import * as alarm from './alarm.js';
import * as alarmAudio from './alarmAudio.js';

const $ = (id) => document.getElementById(id);
const isNative = Capacitor.isNativePlatform();

let settings = { time: '06:30', goal: 10, armed: false };
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

function renderArmState(){
  const el = $('armState');
  if (!settings.armed){
    el.textContent = 'Not armed.';
    el.classList.remove('armed');
    $('armThrough').textContent = '';
    $('ringerNote').textContent = '';
    $('quitNote').textContent = '';
    $('audioWarn').classList.add('hide');
    return;
  }
  const [h, m] = settings.time.split(':').map(Number);
  const t = new Date(); t.setHours(h, m, 0, 0);
  const label = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.textContent = 'Armed for ' + label + ' — ' + settings.goal +
    (settings.goal === 1 ? ' push-up' : ' push-ups') + '.';
  el.classList.add('armed');
  renderArmedThrough();
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
  if (settings.armed && isNative) await alarm.arm(settings.time, settings.goal, settings.sound);
}

$('armBtn').onclick = async () => {
  primeAudio();
  const warn = $('armWarn'), perm = $('permWarn');
  warn.classList.add('hide'); perm.classList.add('hide');

  if (settings.armed){
    settings.armed = false;
    await saveSettings(settings);
    if (isNative) await alarm.disarm();
    await alarmAudio.clearScheduledAlarm();
    await alarmAudio.stopKeepalive();   // release the audio session
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

  // Permission is requested here - at the moment the person asks for an alarm,
  // when the reason is obvious - rather than at launch.
  let status = await alarm.checkPermission();
  if (status !== 'granted') status = await alarm.requestPermission();

  if (status !== 'granted'){
    settings.armed = false;
    await saveSettings(settings);
    warn.classList.remove('hide');
    warn.textContent = status === 'denied'
      ? 'Notifications are off for this app, so it cannot wake you. Turn them on in ' +
        'iOS Settings → Notifications → Dawn Alarm, then arm it again. ' +
        'You can still use "Try it now" while the app is open.'
      : 'Notification permission was not granted, so the alarm cannot ring.';
    renderArmState();
    return;
  }

  const built = await alarm.arm(settings.time, settings.goal, settings.sound);
  const first = built && built.first;
  // Hold the audio session open from now until the alarm fires, and hand the
  // fire time to the native side so the ring does not depend on JS running.
  const audioState = await alarmAudio.startKeepalive();
  if (built && built.first && built.mornings && built.mornings.length){
    await alarmAudio.scheduleAlarm(built.first.getTime(),
                                   alarm.soundFile(settings.sound),
                                   built.mornings[0].key);
  }
  // If the session did not actually come up, the continuous alarm is not going
  // to happen and the user must be told now, not at 06:31.
  lastAudioState = audioState;
  settings.armed = true;
  await saveSettings(settings);
  renderArmState();
  if (first){
    perm.classList.remove('hide');
    perm.textContent = 'Next ring: ' + first.toLocaleString([], {
      weekday: 'short', hour: 'numeric', minute: '2-digit'
    }) + '. iOS caps a notification sound at 30 seconds, so it rings ' +
      alarm.RING_BURST + ' times a minute apart rather than continuously.';
  }
  $('armBtn').textContent = 'Disarm';
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

    if (settings.armed) await alarm.topUp(settings.time, settings.goal, settings.sound);
  }

  // Ask the native side FIRST. showAlarmScreen() calls stopRinging(), so
  // painting it before this check would silence an alarm that is ringing right
  // now, then immediately restart it.
  let resumed = false;
  if (alarmAudio.isNativeAudio){
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
}

boot();
