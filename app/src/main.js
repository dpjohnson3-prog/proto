import './styles.css';
import './paywall.css';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { initCounter } from './counter.js';
import {
  loadSettings, saveSettings, hasSavedSettings, loadSatisfied,
  loadAlarms, saveAlarms, loadAlarmSatisfied, saveAlarmSatisfied,
  loadHistory, saveHistory, flagSeen, markFlag
} from './storage.js';
import * as alarm from './alarm.js';
import * as alarmAudio from './alarmAudio.js';
import * as alarmKit from './alarmKit.js';
import * as store from './store.js';
import { openPaywall, closePaywall, wirePaywall } from './paywall.js';
import {
  DEFAULT_GOAL, DEFAULT_SOUND, EVERY_DAY, LEGACY_ID, NATIVE_REV,
  newAlarm, migrateFromSettings, describeRepeat, hm, dayKey,
  canAdd, canEdit, canEnable, premiumChange, owedState, occurrenceToday, matchesSystem, sortAlarms
} from './alarms.js';
import { addRecord, summarize } from './history.js';
import { TERMS_URL, PRIVACY_URL, restoreMessage } from './premium.js';

const $ = (id) => document.getElementById(id);
const isNative = Capacitor.isNativePlatform();

// JS weekday convention throughout matches Date.getDay(): 0=Sunday.
const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// ---------------------------------------------------------------------------
// MULTIPLE ALARMS (v1.1)
//
// Every alarm is its own AlarmKit alarm under its own id (v1.0's alarm keeps
// the id 'dawn-daily', so the system alarm a 1.0 user already has stays
// mapped through the update). The system owns ringing; this file's job is to
// keep the system's set of alarms equal to the enabled alarms here
// (reconcile), and to route any alarm that is owed push-ups to the ring
// screen before anything else is shown (routeRing).
//
// DAWN PREMIUM never touches an alarm that exists: whatever happens to a
// subscription, every alarm keeps ringing exactly as set, and turning one off
// or deleting it is always free. Premium gates adding alarms, changing reps,
// sound or days, turning a non-free alarm back on, and viewing stats - see
// alarms.js canAdd/canEdit/canEnable.
// ---------------------------------------------------------------------------

function alarmKitLabel(goal){
  return goal + (goal === 1 ? ' push-up' : ' push-ups') + ' to turn it off - tap, don’t swipe';
}

let settings = { alarmBackend: 'alarmkit' };   // global: which engine is in use
let alarms = [];
let satisfied = {};        // { alarmId: 'YYYY-MM-DD' }
let history = [];
let alarmsUnreadable = false;   // saved list could not be read - never cancel system alarms then
let warnings = {};         // { alarmId: message } - scheduling problems shown on the card
let draft = null;          // the alarm being edited (a copy) - null on other screens
let draftIsNew = false;
let counter = null;

// What the current ring is, if any. `real` distinguishes an actual alarm from
// a "Try it now" test: only a real ring can satisfy a morning, or a 06:15 test
// run would cancel the 06:30 alarm it was meant to rehearse.
let activeRing = null;     // { real, morning, alarmId, goal, sound, ringAt }
let lastRealFinish = null; // mode of the last finished real ring, for the done screen

const premium = () => store.isPremium();

// ---------------------------------------------------------------------------
// Screens. counter.js (generated) only knows its own five screens, so the
// home and stats screens are switched here and handed back to it otherwise.
// ---------------------------------------------------------------------------
const OWN_SCREENS = ['sHome', 'sStats'];
function show(name){
  if (name === 'home' || name === 'stats'){
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('on');
    $(name === 'home' ? 'sHome' : 'sStats').classList.add('on');
    return;
  }
  for (const id of OWN_SCREENS) $(id).classList.remove('on');
  counter.show(name);
}

// ---------------------------------------------------------------------------
// Alarm sound for the ring screen (the system alert plays its own copy).
// ---------------------------------------------------------------------------
function srcFor(soundId){ return new URL(alarm.soundUrl(soundId), document.baseURI).href; }
let audio = null, audioFor = null, preview = null, previewTimer = null;

// iOS will not start audio without a user gesture: any tap primes it.
function primeAudio(soundId){
  if (audio && audioFor === soundId) return;
  audio = new Audio(srcFor(soundId));
  audioFor = soundId;
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 1.0;
  audio.play().then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => {});
}

function startRinging(soundId){
  stopPreview();
  if (!audio || audioFor !== soundId){
    audio = new Audio(srcFor(soundId));
    audioFor = soundId;
    audio.loop = true;
  }
  audio.currentTime = 0;
  audio.play().catch((err) => {
    const w = $('soundWarn');
    w.classList.remove('hide');
    w.textContent = (err && err.name === 'NotSupportedError')
      ? 'That sound file is missing — run scripts/make-sounds.py to regenerate it.'
      : 'iOS would not start the sound without a tap. The system alarm itself still made noise.';
  });
}

// The single choke point for silencing the in-app ring sound.
function stopRinging(){
  try { if (audio){ audio.pause(); audio.currentTime = 0; } } catch (e){}
}

// ---------------------------------------------------------------------------
// Keep the screen awake for a set.
// ---------------------------------------------------------------------------
let wakeLock = null, wantAwake = false;
async function requestWakeLock(){
  wantAwake = true;
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e){}
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
// System alarms
// ---------------------------------------------------------------------------
async function scheduleInSystem(a){
  const { hour, minute } = hm(a.time);
  return alarmKit.scheduleAlarm({
    id: a.id, hour, minute, repeatDays: a.repeatDays,
    label: alarmKitLabel(a.goal), sound: alarm.soundFile(a.sound)
  });
}

// null when the system could not be asked - callers must treat that as
// "unknown", never as "no alarms exist".
async function systemAlarms(){
  if (!isNative) return [];
  try { return (await alarmKit.listAlarms()).alarms || []; } catch (e){ return null; }
}

// Under AlarmKit nothing should be pending in the old notification engine.
async function sweepStaleLegacyNotifications(){
  if (!isNative) return;
  try {
    const pending = await LocalNotifications.getPending();
    const ids = (pending.notifications || []).map(n => ({ id: n.id }));
    if (ids.length) await LocalNotifications.cancel({ notifications: ids });
  } catch (e){}
}

// THE BACKSTOP, run on every launch and every foreground return: makes the
// system's alarms match the enabled alarms here. Missing or drifted ->
// rescheduled (schedule-new-then-cancel-old, in DawnAlarmKit.swift, so there
// is never a moment with no alarm). In the system but not enabled here ->
// cancelled. A one-time alarm whose single ring has already happened is never
// rescheduled for another day; it is retired once it is no longer owed.
async function reconcile(){
  if (!isNative) return;
  const sys = await systemAlarms();
  if (sys === null) return;
  const byId = new Map(sys.map(s => [s.id, s]));
  const now = new Date();
  let changed = false;
  for (const a of alarms){
    const s = byId.get(a.id);
    if (!a.enabled){
      if (s){ try { await alarmKit.cancelAlarm(a.id); } catch (e){} }
      continue;
    }
    if (a.repeatDays.length === 0 && a.armedAt){
      const occ = occurrenceToday(a, now, null);
      if (occ && occ.getTime() <= now.getTime()){
        if (!owedState(a, now, satisfied, null).owed){
          try { await alarmKit.cancelAlarm(a.id); } catch (e){}
          a.enabled = false; changed = true;
        }
        continue;
      }
    }
    if (s && matchesSystem(a, s) && (a.nativeRev || 0) >= NATIVE_REV){ delete warnings[a.id]; continue; }
    try {
      await scheduleInSystem(a);
      a.nativeRev = NATIVE_REV;
      if (!a.armedAt) a.armedAt = Date.now();
      changed = true;
      delete warnings[a.id];
    } catch (e){
      warnings[a.id] = 'This alarm is missing from the system and could not be rescheduled. ' +
        'Turn it off and on again, or check Settings → Dawn Alarm → Alarms.';
    }
  }
  for (const s of sys){
    if (alarmsUnreadable) break;
    if (!alarms.some(a => a.id === s.id && a.enabled)){
      try { await alarmKit.cancelAlarm(s.id); } catch (e){}
    }
  }
  if (changed) await saveAlarms(alarms);
}

// Owed push-ups: the earliest enabled alarm that has rung (by its own
// schedule, as the system has it) and has not been satisfied this morning.
// This is what closes the swipe-bypass gap - swiping the alert away never
// reaches the Stop intent, but opening the app by any means after the alarm's
// time still routes to push-ups.
async function firstOwed(sys){
  const now = new Date();
  const list = sys === undefined ? await systemAlarms() : sys;
  const byId = new Map((list || []).map(s => [s.id, s]));
  let best = null;
  for (const a of alarms){
    const st = owedState(a, now, satisfied, byId.get(a.id));
    if (st.owed && (!best || st.at < best.st.at)) best = { a, st };
  }
  return best;
}

// Launch and the first foreground event can both arrive at once: they share
// one run instead of reconciling and routing twice in parallel.
let syncing = null;
function syncAndRoute(){
  if (!syncing){
    syncing = (async () => {
      await sweepStaleLegacyNotifications();
      await reconcile();
      return routeRing();
    })().finally(() => { syncing = null; });
  }
  return syncing;
}

// Routes an owed or just-stopped alarm to the ring screen. True if it did.
async function routeRing(){
  if (!isNative || counter.isRunning()) return false;
  const intent = await alarmKit.consumePushupIntent();
  if (intent.wants){
    const owed = await firstOwed();
    const a = alarms.find(x => x.id === intent.alarmId) || (owed && owed.a) || alarms.find(x => x.enabled);
    await enterRing({ real: true, morning: intent.morning || dayKey(new Date()), alarmId: a ? a.id : null });
    return activeRing !== null;
  }
  const owed = await firstOwed();
  if (!owed) return false;
  await enterRing({ real: true, morning: owed.st.morning, alarmId: owed.a.id, ringAt: owed.st.at });
  return activeRing !== null;
}

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------
async function enterRing({ real = false, morning = null, alarmId = null, ringAt = null, cfg = null } = {}){
  const key = morning || dayKey(new Date());
  const a = alarms.find(x => x.id === alarmId);
  const gate = alarm.shouldRing({
    setInProgress: counter.isRunning(),
    real,
    morning: key,
    satisfiedKey: real && a ? (satisfied[a.id] || null) : null
  });
  if (!gate.ring){
    if (gate.reason === 'already-satisfied') showHome();
    return;
  }
  const src = cfg || a || { goal: DEFAULT_GOAL, sound: DEFAULT_SOUND, time: '06:30' };
  let at = ringAt;
  if (real && !at && a){ const occ = occurrenceToday(a, new Date(), null); at = occ ? occ.getTime() : Date.now(); }
  activeRing = { real, morning: key, alarmId: a ? a.id : null, goal: src.goal, sound: src.sound, ringAt: at };
  // Nothing may sit on top of a ring screen - not a paywall, not settings.
  closePaywall(false);
  closeSettings();
  $('sheet').classList.remove('on');
  const showBack = alarm.backArrowVisible({ real });
  $('ringBack').classList.toggle('hide', !showBack);
  $('sRing').classList.toggle('hasBack', showBack);
  $('soundWarn').classList.add('hide');
  $('ringCount').textContent = src.goal;
  counter.setGoal(src.goal);
  show('ring');
  requestWakeLock();
  startRinging(src.sound);
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function timeLabel(t){
  const { hour, minute } = hm(t);
  const d = new Date(); d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function showHome(){
  releaseWakeLock();
  stopRinging();
  stopPreview();
  counter.reset();
  draft = null;
  renderHome();
  show('home');
}

function renderHome(){
  renderDebugState();
  const list = $('alarmList');
  list.textContent = '';
  for (const a of sortAlarms(alarms)){
    const card = document.createElement('div');
    card.className = 'alarmCard' + (a.enabled ? '' : ' off');
    card.setAttribute('role', 'listitem');
    const main = document.createElement('button');
    main.className = 'alarmMain';
    main.type = 'button';
    main.setAttribute('aria-label', 'Edit ' + timeLabel(a.time) + ' alarm');
    const t = document.createElement('span'); t.className = 'alarmTime'; t.textContent = timeLabel(a.time);
    const sub = document.createElement('span'); sub.className = 'alarmSub';
    sub.textContent = describeRepeat(a.repeatDays) + ' · ' + a.goal + (a.goal === 1 ? ' push-up' : ' push-ups') +
      ' · ' + alarm.soundOf(a.sound).label;
    main.append(t, sub);
    if (warnings[a.id]){
      const e = document.createElement('span'); e.className = 'alarmErr'; e.textContent = warnings[a.id];
      main.appendChild(e);
    }
    main.onclick = () => openEditor(a.id);
    const sw = document.createElement('button');
    sw.className = 'switch';
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(a.enabled));
    sw.setAttribute('aria-label', (a.enabled ? 'Turn off ' : 'Turn on ') + timeLabel(a.time) + ' alarm');
    sw.onclick = () => (a.enabled ? turnOff(a.id) : turnOn(a.id));
    card.append(main, sw);
    list.appendChild(card);
  }
  $('addAlarm').classList.toggle('lock', !canAdd(alarms, premium()));
  $('statsBtn').classList.toggle('lock', !premium());
  renderPremiumNotes();
}

function renderPremiumNotes(){
  const lapsed = $('lapsedNote');
  const ended = !premium() && store.everPremium() && alarms.length > 0;
  lapsed.classList.toggle('hide', !ended);
  if (ended){
    lapsed.textContent = 'Your Dawn Premium has ended. Every alarm keeps ringing exactly as set. ' +
      'Changing them or adding new ones needs Premium; turning one off is always free.';
  }
  renderSettingsStatus();
}

function homeWarn(text){
  const w = $('homeWarn');
  w.classList.toggle('hide', !text);
  w.textContent = text || '';
}

// Before an alarm is turned off or deleted: a ringing or owed alarm must be
// pushed through the ring screen first, never silently turned off - so that
// turning it off can never become a way around the push-ups.
async function refuseIfOwed(a){
  if (activeRing && activeRing.real) return true;
  if (!isNative) return false;
  const sys = await systemAlarms();
  const s = (sys || []).find(x => x.id === a.id);
  const st = owedState(a, new Date(), satisfied, s);
  if (st.owed){
    await enterRing({ real: true, morning: st.morning, alarmId: a.id, ringAt: st.at });
    return true;
  }
  return false;
}

// Turning an alarm OFF is never gated by Premium.
async function turnOff(id){
  const a = alarms.find(x => x.id === id);
  if (!a || !a.enabled) return;
  if (await refuseIfOwed(a)) return;
  // Cancel in the system FIRST, then reflect it here - never the other way
  // round, or the app could say "off" while the system alarm still exists.
  if (isNative){
    try { await alarmKit.cancelAlarm(a.id); }
    catch (e){ homeWarn('Could not turn that alarm off (' + e + '). Try again.'); return; }
  }
  a.enabled = false;
  await saveAlarms(alarms);
  homeWarn('');
  renderHome();
}

// AlarmKit permission is asked fresh on every enable: it can change in
// Settings at any time. There is no silent fallback - either it is armed in
// the system, or it plainly is not and says so.
async function ensureAuthorized(){
  if (!isNative) return true;
  const status = (await alarmKit.requestAuthorization()).status;
  if (status === 'authorized') return true;
  homeWarn((status === 'denied'
    ? 'Alarm permission is off for this app, so it cannot wake you. Turn it on in '
    : 'Alarm permission was not granted, so the alarm cannot be turned on. Turn it on in ') +
    'iOS Settings → Dawn Alarm → Alarms, then try again. You can still use "Try it now".');
  return false;
}

async function turnOn(id){
  const a = alarms.find(x => x.id === id);
  if (!a || a.enabled) return;
  primeAudio(a.sound);
  if (!canEnable(a, alarms, premium())){
    if (!(await openPaywall({ reason: alarms.filter(x => x.enabled).length ? 'alarms' : 'edit' }))) return;
  }
  if (!(await ensureAuthorized())) return;
  if (isNative){
    try { await scheduleInSystem(a); }
    catch (e){ homeWarn('Scheduling failed (' + e + '). The alarm is NOT on - try again.'); return; }
  }
  a.enabled = true;
  a.armedAt = Date.now();
  a.nativeRev = NATIVE_REV;
  settings.alarmBackend = 'alarmkit';
  await saveSettings(settings);
  await saveAlarms(alarms);
  homeWarn('');
  renderHome();
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
async function newAlarmTapped(){
  if (!canAdd(alarms, premium())){
    if (!(await openPaywall({ reason: 'alarms' }))) return;
  }
  draft = newAlarm({ time: '06:30' });
  draftIsNew = true;
  showEditor();
}

function openEditor(id){
  const a = alarms.find(x => x.id === id);
  if (!a) return;
  draft = { ...a, repeatDays: [...a.repeatDays] };
  draftIsNew = false;
  showEditor();
}

function editable(){
  if (!draft) return false;
  if (draftIsNew) return true;
  return canEdit(draft, alarms, premium());
}

function showEditor(){
  stopPreview();
  $('editTitle').textContent = draftIsNew ? 'New alarm' : 'Edit alarm';
  $('alarmTime').value = draft.time;
  $('deleteBtn').style.display = draftIsNew ? 'none' : '';
  $('armWarn').classList.add('hide');
  renderEditor();
  show('alarm');
}

function renderEditor(){
  const locked = !editable();
  const lockNote = $('editLocked');
  lockNote.classList.toggle('hide', !locked);
  lockNote.textContent = locked
    ? 'This alarm keeps ringing exactly as set. Changing it needs Dawn Premium; turning it off or deleting it is always free.'
    : '';
  $('alarmTime').disabled = locked;
  $('goalVal').textContent = draft.goal;
  const p = premium();
  $('goalVal').classList.toggle('lock', !p);
  $('plus').classList.toggle('lock', !p);
  $('minus').classList.toggle('lock', !p);
  renderRepeatDays();
  renderSounds();
  $('saveBtn').textContent = locked ? 'Unlock to edit' : (draftIsNew ? 'Save and turn on' : 'Save');
}

// A Premium control was tapped: ask first. Resolves true if it may proceed.
async function premiumGate(reason){
  if (premium()) return true;
  const ok = await openPaywall({ reason });
  if (ok) renderEditor();
  return ok;
}

// Empty selection is a deliberate state - a one-time alarm, not an error.
function renderRepeatDays(){
  const wrap = $('repeatDays');
  wrap.textContent = '';
  const p = premium();
  for (let d = 0; d < 7; d++){
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = DAY_SHORT[d];
    const on = draft.repeatDays.includes(d);
    b.setAttribute('aria-pressed', String(on));
    b.onclick = async () => {
      if (!editable() && !(await premiumGate('edit'))) return;
      if (!(await premiumGate('days'))) return;
      draft.repeatDays = on ? draft.repeatDays.filter(x => x !== d) : [...draft.repeatDays, d];
      renderRepeatDays();
    };
    wrap.appendChild(b);
  }
  $('repeatLabel').classList.toggle('lock', !p);
  $('repeatNote').textContent = describeRepeat(draft.repeatDays) +
    (draft.repeatDays.length === 0 ? ' - rings once, then turns itself off.' : '.');
}

function stopPreview(){
  if (previewTimer){ clearTimeout(previewTimer); previewTimer = null; }
  if (preview){ try { preview.pause(); } catch (e){} preview = null; }
  $('soundPreview').classList.remove('playing');
  $('soundPreview').textContent = 'Preview';
}

function renderSounds(){
  const wrap = $('soundChips');
  wrap.textContent = '';
  const p = premium();
  for (const s of alarm.SOUNDS){
    const b = document.createElement('button');
    b.className = 'chip' + (!p && s.id !== DEFAULT_SOUND ? ' lock' : '');
    b.type = 'button';
    b.textContent = s.label;
    b.setAttribute('aria-pressed', String(s.id === draft.sound));
    b.onclick = async () => {
      if (s.id !== DEFAULT_SOUND || !editable()){
        if (!editable() && !(await premiumGate('edit'))) return;
        if (!(await premiumGate('sound'))) return;
      }
      draft.sound = s.id;
      renderSounds();
      playPreview(s.id);
    };
    wrap.appendChild(b);
  }
  $('soundNote').textContent = alarm.soundOf(draft.sound).note;
}

function playPreview(soundId){
  stopPreview();
  preview = new Audio(srcFor(soundId));
  preview.loop = false;
  $('soundPreview').classList.add('playing');
  $('soundPreview').textContent = 'Stop';
  preview.play().catch(() => { stopPreview(); });
  preview.onended = stopPreview;
  previewTimer = setTimeout(stopPreview, 6000);
}

async function saveDraft(){
  if (!draft) return;
  const warn = $('armWarn');
  warn.classList.add('hide');
  primeAudio(draft.sound);
  if (!editable() && !(await premiumGate('edit'))) return;
  const need = premiumChange(draft);
  if (need && !(await premiumGate(need))) return;
  if (draftIsNew && !canAdd(alarms, premium()) && !(await premiumGate('alarms'))) return;

  const existing = alarms.find(x => x.id === draft.id);
  const wasEnabled = draftIsNew ? true : !!(existing && existing.enabled);
  const next = { ...draft, repeatDays: [...draft.repeatDays] };

  if (wasEnabled){
    // An enabled alarm whose time, reps, sound or days just changed is
    // rebuilt in the system FIRST. Only once that has landed is the change
    // saved here - a failure must never leave it looking changed while the
    // system still has the old one, or (worse) half-updated.
    if (!(await ensureAuthorized())){ show('home'); renderHome(); return; }
    if (isNative){
      try { await scheduleInSystem(next); }
      catch (e){
        warn.classList.remove('hide');
        warn.textContent = 'Could not save the alarm (' + e + '). Nothing was changed - try again.';
        return;
      }
    }
    next.enabled = true;
    next.armedAt = Date.now();
    next.nativeRev = NATIVE_REV;
    settings.alarmBackend = 'alarmkit';
    await saveSettings(settings);
  }
  alarms = existing ? alarms.map(x => x.id === next.id ? next : x) : [...alarms, next];
  delete warnings[next.id];
  await saveAlarms(alarms);
  showHome();
}

async function deleteDraft(){
  if (!draft || draftIsNew) return;
  const a = alarms.find(x => x.id === draft.id);
  if (!a){ showHome(); return; }
  if (a.enabled){
    if (await refuseIfOwed(a)) return;
    if (isNative){
      try { await alarmKit.cancelAlarm(a.id); }
      catch (e){
        $('armWarn').classList.remove('hide');
        $('armWarn').textContent = 'Could not delete the alarm (' + e + '). Try again.';
        return;
      }
    }
  }
  alarms = alarms.filter(x => x.id !== a.id);
  delete satisfied[a.id];
  await saveAlarmSatisfied(satisfied);
  await saveAlarms(alarms);
  showHome();
}

// ---------------------------------------------------------------------------
// Stats (Premium to view; recorded for everyone)
// ---------------------------------------------------------------------------
async function openStats(){
  if (!premium() && !(await openPaywall({ reason: 'stats' }))) return;
  const s = summarize(history, new Date());
  $('stStreak').textContent = s.streak;
  $('stStreakLbl').textContent = 'morning streak';
  $('stBest').textContent = s.best;
  $('stMornings').textContent = s.mornings;
  $('stPushups').textContent = s.pushups;
  $('stAvg').textContent = s.avgMinutes == null ? '–' : s.avgMinutes;
  const dots = $('stDots');
  dots.textContent = '';
  for (const d of s.last30){
    const i = document.createElement('i');
    if (d.state) i.className = d.state;
    i.title = d.day + (d.state === 'won' ? ': up' : d.state === 'lost' ? ': turned off' : '');
    dots.appendChild(i);
  }
  $('stEmpty').textContent = history.length ? '' : 'Your first morning will show up here after your alarm rings and you finish your push-ups.';
  show('stats');
}

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
function renderSettingsStatus(){
  $('setStatus').textContent = store.statusLine();
  const p = premium();
  $('setPlans').style.display = p ? 'none' : '';
  const e = store.live();
  const manageable = p && !store.isLegacy() && !(e && e.lifetime);
  $('setManage').style.display = manageable ? '' : 'none';
}
function openSettings(){
  $('setMsg').textContent = '';
  renderSettingsStatus();
  $('settingsSheet').classList.add('on');
  store.refresh().then(renderHome);
}
function closeSettings(){ $('settingsSheet').classList.remove('on'); }

function wireSettings(){
  $('settingsBtn').onclick = openSettings;
  $('setClose').onclick = closeSettings;
  $('setTerms').href = TERMS_URL;
  $('setPrivacy').href = PRIVACY_URL;
  $('setPlans').onclick = async () => { closeSettings(); await openPaywall({ reason: 'settings' }); renderHome(); };
  $('setRestore').onclick = async () => {
    $('setRestore').disabled = true;
    $('setMsg').textContent = 'Restoring…';
    const r = await store.restore();
    $('setRestore').disabled = false;
    $('setMsg').textContent = restoreMessage(r);
    renderHome();
  };
  $('setRedeem').onclick = () => store.redeemCode();
  $('setManage').onclick = () => store.manage();
  (async () => {
    try {
      const info = isNative ? await App.getInfo() : { version: 'web', build: '' };
      $('setVersion').textContent = 'Dawn ' + info.version + (info.build ? ' (' + info.build + ')' : '');
    } catch (e){}
  })();
}

// v1.0 thank-you, once.
async function maybeShowLegacyThanks(){
  if (!store.isLegacy() || await flagSeen('legacyThanks')) return;
  await markFlag('legacyThanks');
  const b = $('legacyNote');
  b.classList.remove('hide');
  b.textContent = 'Dawn now has Premium: unlimited alarms, custom reps, every sound, repeat schedules and stats. ' +
    'You were here from version 1.0, so it’s yours free, for life. Thank you.';
}

// ---------------------------------------------------------------------------
// Dev-only on-screen debug readout (compiled out of release builds).
// ---------------------------------------------------------------------------
function renderDebugState(){
  const el = $('debugState');
  if (!el) return;
  if (!import.meta.env?.DEV || !isNative){ el.textContent = ''; return; }
  (async () => {
    try {
      const ak = await alarmKit.listAlarms();
      const dbg = ak.debug || {};
      el.textContent = 'AlarmKit alarms: ' + JSON.stringify(ak.alarms) +
        '\nlast Stop intent ran at: ' + (dbg.lastStopIntentAt || '(never)') +
        '\nlast follow-up error: ' + (dbg.lastFollowUpError || '(none)') +
        '\nfollow-ups: ' + (dbg.followUpAlarmState || '(unknown)') +
        '\npremium: ' + JSON.stringify(store.access());
    } catch (e){ el.textContent = 'debug state failed: ' + e; }
  })();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireUI(){
  $('addAlarm').onclick = newAlarmTapped;
  $('statsBtn').onclick = openStats;
  $('statsBack').onclick = showHome;
  $('editBack').onclick = showHome;
  $('saveBtn').onclick = saveDraft;
  $('deleteBtn').onclick = deleteDraft;

  $('plus').onclick = async () => {
    if (!editable() && !(await premiumGate('edit'))) return;
    if (!(await premiumGate('reps'))) return;
    draft.goal = Math.min(50, draft.goal + 1);
    $('goalVal').textContent = draft.goal;
  };
  $('minus').onclick = async () => {
    if (!editable() && !(await premiumGate('edit'))) return;
    if (!(await premiumGate('reps'))) return;
    draft.goal = Math.max(1, draft.goal - 1);
    $('goalVal').textContent = draft.goal;
  };
  $('alarmTime').onchange = (e) => { if (draft) draft.time = e.target.value || draft.time; };

  $('soundPreview').onclick = () => {
    if (preview){ stopPreview(); return; }
    if (!draft) return;
    primeAudio(draft.sound);
    playPreview(draft.sound);
  };

  // Practice runs are always free and never touch a real alarm.
  $('testBtn').onclick = () => {
    const a = sortAlarms(alarms).find(x => x.enabled) || alarms[0];
    const cfg = a || { goal: DEFAULT_GOAL, sound: DEFAULT_SOUND };
    primeAudio(cfg.sound);
    enterRing({ real: false, cfg });
  };
  $('tryAlarmBtn').onclick = () => {
    if (!draft) return;
    primeAudio(draft.sound);
    enterRing({ real: false, cfg: { ...draft } });
  };

  // Never trap someone on the ringing screen: the escape sheet is reachable
  // before a single rep is attempted.
  $('ringEscape').onclick = () => { $('sheet').classList.add('on'); };

  // Back out of a TEST run only (the arrow is not rendered for a real alarm).
  // This deliberately does NOT go through onFinish: abandoning a rehearsal must
  // not satisfy a morning or touch a single real alarm.
  $('ringBack').onclick = () => {
    if (activeRing && activeRing.real) return;   // belt and braces
    activeRing = null;
    showHome();
  };

  $('againBtn').onclick = async () => {
    showHome();
    // Once, after the first successful MORNING (a real alarm, finished with
    // reps or the timer - never a practice run, never a bail), to someone
    // without Premium. Always dismissible, and the sound is already off.
    const mode = lastRealFinish;
    lastRealFinish = null;
    if (!mode || mode === 'bail' || premium() || await flagSeen('morningPaywall')) return;
    await markFlag('morningPaywall');
    await openPaywall({ reason: 'morning' });
    renderHome();
  };
}

// ---------------------------------------------------------------------------
// Boot. Kept inside a function rather than using top-level await, so the
// bundle stays within the es2020 target WKWebView is guaranteed to handle.
// ---------------------------------------------------------------------------
async function boot(){
  settings = await loadSettings();
  // Local-only (v1.0 install check, cached Premium status) and capped, so a
  // hang here can never delay routing a ringing alarm below.
  try { await Promise.race([store.init(), new Promise(r => setTimeout(r, 2500))]); } catch (e){}

  // v1.0 -> v1.1: the single saved alarm becomes the first alarm, under the
  // same id its live system alarm already has, armed state and all.
  let list = await loadAlarms();
  satisfied = await loadAlarmSatisfied();
  if (list === 'unreadable'){
    // Never guess here: rebuild from what the system actually has scheduled,
    // so every alarm that exists keeps ringing and stays manageable.
    alarmsUnreadable = true;
    const sys = (await systemAlarms()) || [];
    list = sys.map(s => ({ ...newAlarm({ id: s.id }), time: String(s.hour).padStart(2, '0') + ':' + String(s.minute).padStart(2, '0'),
      repeatDays: s.repeatDays || [...EVERY_DAY], enabled: true, armedAt: Date.now(), nativeRev: 0 }));
    if (list.length){ await saveAlarms(list); alarmsUnreadable = false; }
  } else if (!Array.isArray(list)){
    list = migrateFromSettings((await hasSavedSettings()) ? settings : null);
    const legacySat = await loadSatisfied();
    if (legacySat && list.length) satisfied[LEGACY_ID] = legacySat;
    await saveAlarmSatisfied(satisfied);
    await saveAlarms(list);
  }
  alarms = list;
  history = await loadHistory();

  // A pre-AlarmKit build's notification + background-audio engine, if one
  // was ever armed here, is torn down; reconcile() then schedules the same
  // alarm through AlarmKit.
  if (isNative && settings.alarmBackend === 'legacy'){
    try { await alarm.disarm(); } catch (e){}
    try { await alarmAudio.clearScheduledAlarm(); await alarmAudio.stopKeepalive(); } catch (e){}
    settings.alarmBackend = 'alarmkit';
    await saveSettings(settings);
  }

  counter = initCounter({
    goal: DEFAULT_GOAL,
    onFinish: async (mode, count) => {
      stopRinging();
      releaseWakeLock();
      $('againBtn').textContent = 'Back to the alarm';
      // A set is finished. This is the ONLY thing that satisfies a morning:
      // reps completed, the 30-second timer run down, or a deliberate bail.
      // The escape hatches are legitimate exits and count as satisfied; a
      // notification tap, a swipe, or opening and abandoning the app do not.
      const ring = activeRing;
      activeRing = null;
      if (!ring || !ring.real) return;
      lastRealFinish = mode;
      history = addRecord(history, {
        day: ring.morning, alarmId: ring.alarmId, mode, reps: mode === 'reps' ? count : 0,
        at: Date.now(), ringAt: ring.ringAt
      });
      await saveHistory(history);
      if (!isNative) return;
      // You are up: this alarm, and any other alarm that has also rung and is
      // owed right now, are satisfied for their morning. Alarms that have not
      // rung yet today still ring later.
      const now = new Date();
      const sys = await systemAlarms();
      const byId = new Map((sys || []).map(s => [s.id, s]));
      const done = [];
      if (ring.alarmId){ satisfied[ring.alarmId] = ring.morning; done.push(ring.alarmId); }
      for (const a of alarms){
        const st = owedState(a, now, satisfied, byId.get(a.id));
        if (st.owed){ satisfied[a.id] = st.morning; done.push(a.id); }
      }
      await saveAlarmSatisfied(satisfied);
      await alarm.markSatisfied(ring.morning);
      // Cancels every pending "ring again" follow-up; the recurring alarms
      // themselves are untouched, so tomorrow still rings.
      await alarmKit.completeMission();
      // A one-time alarm (no repeat days) just had its only ring - retired
      // here, whether it was finished or bailed on. Cancel in the system
      // FIRST, then flip enabled - never the other way round.
      let changed = false;
      for (const id of done){
        const a = alarms.find(x => x.id === id);
        if (a && a.enabled && a.repeatDays.length === 0){
          try { await alarmKit.cancelAlarm(a.id); } catch (e){}
          a.enabled = false;
          changed = true;
        }
      }
      if (changed) await saveAlarms(alarms);
    }
  });

  wireUI();
  wirePaywall();
  wireSettings();
  store.onChange(() => renderHome());

  if (isNative){
    App.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive) return;
      // Tapping the system alert's button brings the app forward - this is
      // the first chance JS gets to act on it. reconcile() first: every
      // foreground return is a chance to fix a missing alarm.
      await syncAndRoute();
      if (!activeRing && !counter.isRunning() && !draft && $('sHome').classList.contains('on')) renderHome();
      store.refresh();
    });
  }

  // Route a ringing / owed alarm BEFORE painting anything else.
  let resumed = false;
  if (isNative){
    resumed = await syncAndRoute();
  }
  if (!resumed) showHome();

  // Premium status from StoreKit, after the alarm has been routed.
  store.refresh().then(async () => { renderHome(); await maybeShowLegacyThanks(); });

  if (isNative){
    try {
      if (localStorage.getItem('dawn.debug') === '1'){
        window.dawnDebugState = async () => ({
          settings, alarms, satisfied, alarmKitAlarms: (await alarmKit.listAlarms()).alarms, premium: store.access()
        });
      }
    } catch (e){}
  }
}

boot();
