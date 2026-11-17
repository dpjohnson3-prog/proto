// Persisted alarm settings. @capacitor/preferences maps to NSUserDefaults on
// iOS and localStorage on the web, so this works in `vite dev` too.
import { Preferences } from '@capacitor/preferences';

const KEY = 'dawn.alarm';

// alarmBackend records which alarm mechanism is actually armed, so disarm and
// the next launch know which one to tear down / check - 'alarmkit' (iOS
// 26.1+, preferred) or 'legacy' (notifications + background audio, the only
// option below that, or if AlarmKit authorization was denied).
// repeatDays: JS weekday ints (0=Sunday..6=Saturday, matching Date.getDay()).
// All seven means "every day" (the original, only behaviour); empty means a
// one-time alarm - fires its next occurrence once, then disarms itself.
export const DEFAULTS = {
  time: '06:30', goal: 10, armed: false, sound: 'chime', alarmBackend: 'legacy',
  repeatDays: [0, 1, 2, 3, 4, 5, 6]
};

export async function loadSettings(){
  try {
    const { value } = await Preferences.get({ key: KEY });
    if (!value) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(value) };
  } catch (e){
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s){
  try { await Preferences.set({ key: KEY, value: JSON.stringify(s) }); }
  catch (e){ /* a failed write must never block dismissing an alarm */ }
}

// Record of what we actually scheduled, so a completed set can cancel just
// this morning's remaining notifications without wiping the future ones.
const SCHED_KEY = 'dawn.scheduled';

export async function loadScheduled(){
  try {
    const { value } = await Preferences.get({ key: SCHED_KEY });
    return value ? JSON.parse(value) : [];
  } catch (e){ return []; }
}

export async function saveScheduled(list){
  try { await Preferences.set({ key: SCHED_KEY, value: JSON.stringify(list) }); }
  catch (e){}
}

// Which morning's alarm has actually been satisfied, as a local YYYY-MM-DD
// key. This is the durable record that a set was completed, so that a
// notification tapped out of Notification Center hours later - or a rebuild of
// the schedule - cannot resurrect a morning whose reps are already done.
const SAT_KEY = 'dawn.satisfied';

export async function loadSatisfied(){
  try {
    const { value } = await Preferences.get({ key: SAT_KEY });
    return value || null;
  } catch (e){ return null; }
}

export async function saveSatisfied(dayKey){
  try { await Preferences.set({ key: SAT_KEY, value: dayKey }); }
  catch (e){}
}

// ---------------------------------------------------------------------------
// v1.1: multiple alarms, per-alarm satisfied mornings, history, UI flags.
// ---------------------------------------------------------------------------
async function getJSON(key, fallback){
  try {
    const { value } = await Preferences.get({ key });
    return value ? JSON.parse(value) : fallback;
  } catch (e){ return fallback; }
}
async function setJSON(key, v){
  try { await Preferences.set({ key, value: JSON.stringify(v) }); } catch (e){}
}

// Whether a v1.0 settings record exists at all (loadSettings() fills in
// defaults, so it cannot tell "never saved" from "saved the defaults").
export async function hasSavedSettings(){
  try { return !!(await Preferences.get({ key: KEY })).value; } catch (e){ return false; }
}

// null = never saved (first v1.1 launch -> migrate from 'dawn.alarm').
// 'unreadable' = a record exists but could not be parsed - distinct from
// "never saved", so a corrupt record is never mistaken for "no alarms".
export async function loadAlarms(){
  let raw = null;
  try { raw = (await Preferences.get({ key: 'dawn.alarms' })).value; } catch (e){ return 'unreadable'; }
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : 'unreadable'; } catch (e){ return 'unreadable'; }
}
export const saveAlarms = (list) => setJSON('dawn.alarms', list);

// { alarmId: 'YYYY-MM-DD' } - the morning each alarm was last satisfied.
export const loadAlarmSatisfied = () => getJSON('dawn.satisfiedAlarms', {});
export const saveAlarmSatisfied = (m) => setJSON('dawn.satisfiedAlarms', m);

export const loadHistory = () => getJSON('dawn.history', []);
export const saveHistory = (h) => setJSON('dawn.history', h);

export async function flagSeen(name){ return !!(await getJSON('dawn.seen.' + name, false)); }
export async function markFlag(name){ await setJSON('dawn.seen.' + name, true); }
