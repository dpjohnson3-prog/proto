// Persisted alarm settings. @capacitor/preferences maps to NSUserDefaults on
// iOS and localStorage on the web, so this works in `vite dev` too.
import { Preferences } from '@capacitor/preferences';

const KEY = 'dawn.alarm';

export const DEFAULTS = { time: '06:30', goal: 10, armed: false, sound: 'chime' };

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
