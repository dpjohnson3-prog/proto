import './styles.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { initCounter } from './counter.js';
import { loadSettings, saveSettings } from './storage.js';
import * as alarm from './alarm.js';

const $ = (id) => document.getElementById(id);
const isNative = Capacitor.isNativePlatform();

let settings = { time: '06:30', goal: 10, armed: false };
let counter = null;

// What the current ring is, if any. `real` distinguishes an actual alarm from
// a "Try it now" test: only a real ring can satisfy a morning, or a 06:15 test
// run would cancel the 06:30 alarm it was meant to rehearse.
let activeRing = null;

// ---------------------------------------------------------------------------
// Alarm sound.
// ---------------------------------------------------------------------------
// TODO(sound): no audio file ships with this repo on purpose. Drop a real one
// at app/public/sounds/alarm.wav (in-app playback) AND ios/App/App/alarm.wav
// (the notification sound). See ios-assets/sounds/README.md for the format
// rules. Until then the ring screen says so out loud rather than failing quietly.
const ALARM_SRC = '/sounds/alarm.wav';
let audio = null;

// iOS will not start audio without a user gesture. Arming is a gesture, so we
// use it to unlock playback for the session; if the app was relaunched cold by
// the notification, the "Start push-ups" tap is the next gesture available.
function primeAudio(){
  if (audio) return;
  audio = new Audio(ALARM_SRC);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 1.0;
  audio.play().then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => {});
}

function startRinging(){
  if (!audio){ audio = new Audio(ALARM_SRC); audio.loop = true; }
  audio.currentTime = 0;
  audio.play().catch((err) => {
    const w = $('soundWarn');
    w.classList.remove('hide');
    w.textContent = (err && err.name === 'NotSupportedError')
      ? 'No alarm sound installed yet — add app/public/sounds/alarm.wav (see ios-assets/sounds/README.md).'
      : 'iOS would not start the sound without a tap. The notification itself still made noise.';
  });
}

function stopRinging(){
  try { if (audio){ audio.pause(); audio.currentTime = 0; } } catch (e){}
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
  $('alarmTime').value = settings.time;
  $('goalVal').textContent = settings.goal;
  $('armBtn').textContent = settings.armed ? 'Disarm' : 'Arm the alarm';
  renderArmState();
  counter.show('alarm');
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
  const built = alarm.buildNotifications(settings.time, settings.goal, new Date(), null);
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
    return;
  }
  const [h, m] = settings.time.split(':').map(Number);
  const t = new Date(); t.setHours(h, m, 0, 0);
  const label = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.textContent = 'Armed for ' + label + ' — ' + settings.goal +
    (settings.goal === 1 ? ' push-up' : ' push-ups') + '.';
  el.classList.add('armed');
  renderArmedThrough();
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
  if (settings.armed && isNative) await alarm.arm(settings.time, settings.goal);
}

$('armBtn').onclick = async () => {
  primeAudio();
  const warn = $('armWarn'), perm = $('permWarn');
  warn.classList.add('hide'); perm.classList.add('hide');

  if (settings.armed){
    settings.armed = false;
    await saveSettings(settings);
    if (isNative) await alarm.disarm();
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

  const first = await alarm.arm(settings.time, settings.goal);
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

$('testBtn').onclick = () => { primeAudio(); enterRing({ real: false }); };

// Never trap someone on the ringing screen either: the same escape sheet the
// counting screen uses is reachable before a single rep is attempted.
$('ringEscape').onclick = () => { $('sheet').classList.add('on'); };

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
      // Now this morning is settled, refill the window to its full depth.
      if (settings.armed) await alarm.topUp(settings.time, settings.goal);
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
      if (isActive && settings.armed) await alarm.topUp(settings.time, settings.goal);
    });

    if (settings.armed) await alarm.topUp(settings.time, settings.goal);
  }

  showAlarmScreen();
}

boot();
