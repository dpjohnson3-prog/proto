// Multiple alarms (v1.1): the model, the v1.0 migration, the free/Premium
// rules, and "is this alarm owed push-ups right now". Pure - no Capacitor
// imports - so scripts/verify-premium.mjs can test every branch in Node.
//
// An alarm: { id, time:'HH:MM', goal, sound, repeatDays:[0..6], enabled,
//             armedAt:ms|null, createdAt:ms, nativeRev }
//   repeatDays uses Date.getDay() numbering (0 = Sunday). Empty = one-time.
//   armedAt is when the alarm was last (re)scheduled in the system. An
//   occurrence before armedAt never happened, so it can never be owed - that
//   is what stops "arm a 06:30 alarm at 21:00, reopen the app at 21:05" from
//   demanding push-ups for a ring that never took place.
//   nativeRev records which native schedule format the alarm was created
//   with; anything below NATIVE_REV is rescheduled once so its Stop button
//   carries its own id (see DawnAlarmKit.swift, MULTIPLE ALARMS).

export const DEFAULT_GOAL = 10;
export const DEFAULT_SOUND = 'chime';
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export const LEGACY_ID = 'dawn-daily';      // v1.0's one AlarmKit id - kept so the live system alarm stays mapped
export const NATIVE_REV = 2;
// A one-time alarm's ring stays "owed" this long - long enough to cover
// someone who swiped it away and went back to sleep.
export const ONE_TIME_OWED_MS = 12 * 3600 * 1000;

const DAY_LONG = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayKey(d){
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

export function newAlarm({ time = '06:30', now = Date.now(), id } = {}){
  return {
    id: id || ('a' + now.toString(36) + Math.random().toString(36).slice(2, 7)),
    time, goal: DEFAULT_GOAL, sound: DEFAULT_SOUND, repeatDays: [...EVERY_DAY],
    enabled: false, armedAt: null, createdAt: now, nativeRev: NATIVE_REV
  };
}

// v1.0 kept one settings object ('dawn.alarm'). It becomes the first alarm,
// under the SAME id the system alarm is already scheduled with, armed state
// and all - an update must not leave anyone without tomorrow's alarm.
export function migrateFromSettings(settings, now = Date.now()){
  if (!settings) return [];
  const sch = Array.isArray(settings.repeatDays) ? settings.repeatDays : EVERY_DAY;
  return [{
    id: LEGACY_ID,
    time: settings.time || '06:30',
    goal: settings.goal || DEFAULT_GOAL,
    sound: settings.sound || DEFAULT_SOUND,
    repeatDays: [...sch],
    enabled: !!settings.armed,
    armedAt: settings.armed ? now : null,
    createdAt: now,
    nativeRev: 1
  }];
}

export function describeRepeat(days){
  if (!days || days.length === 0) return 'Once';
  if (days.length === 7) return 'Every day';
  const s = [...days].sort((a, b) => a - b).join(',');
  if (s === '1,2,3,4,5') return 'Weekdays';
  if (s === '0,6') return 'Weekends';
  return [...days].sort((a, b) => a - b).map(d => DAY_LONG[d]).join(', ');
}

export function hm(time){ const [h, m] = time.split(':').map(Number); return { hour: h, minute: m }; }

// ---------------------------------------------------------------------------
// Free vs Premium. Free: one alarm, every day, the default rep count and the
// default sound. Premium: more alarms, custom reps, every sound, repeat
// schedules (specific days or one-time), and stats history.
//
// Premium ending never touches an alarm: everything keeps ringing as set.
// Turning an alarm OFF or deleting it is always allowed. Changing one, adding
// one, or turning one back ON is allowed only if the result fits the free tier.
// ---------------------------------------------------------------------------
export function isFreeCompatible(a){
  return a.goal === DEFAULT_GOAL && a.sound === DEFAULT_SOUND &&
    Array.isArray(a.repeatDays) && a.repeatDays.length === 7;
}

export function canAdd(alarms, premium){
  return premium || alarms.length === 0;
}

export function canEdit(a, alarms, premium){
  if (premium) return true;
  return alarms.length === 1 && alarms[0].id === a.id && isFreeCompatible(a);
}

export function canEnable(a, alarms, premium){
  if (premium) return true;
  if (!isFreeCompatible(a)) return false;
  return !alarms.some(x => x.id !== a.id && x.enabled);
}

// Which Premium-only change (if any) a draft makes, for the paywall prompt.
export function premiumChange(draft){
  if (draft.goal !== DEFAULT_GOAL) return 'reps';
  if (draft.sound !== DEFAULT_SOUND) return 'sound';
  if (!draft.repeatDays || draft.repeatDays.length !== 7) return 'days';
  return null;
}

// ---------------------------------------------------------------------------
// Owed push-ups. `sys` is the live system alarm ({hour, minute, repeatDays})
// when known - the truth for when it actually rang - else the saved alarm.
// Returns { owed:true, morning:'YYYY-MM-DD', at:ms } or { owed:false }.
// ---------------------------------------------------------------------------
export function occurrenceToday(a, now, sys){
  const { hour, minute } = sys && Number.isInteger(sys.hour) ? sys : hm(a.time);
  const days = sys && Array.isArray(sys.repeatDays) ? sys.repeatDays : a.repeatDays;
  const occ = new Date(now); occ.setHours(hour, minute, 0, 0);
  if (days.length === 0){
    // One-time: the first hh:mm strictly after it was armed.
    if (!a.armedAt) return null;
    const first = new Date(a.armedAt); first.setHours(hour, minute, 0, 0);
    if (first.getTime() <= a.armedAt) first.setDate(first.getDate() + 1);
    return first;
  }
  return days.includes(occ.getDay()) ? occ : null;
}

export function owedState(a, now, satisfied, sys){
  if (!a.enabled) return { owed: false };
  const occ = occurrenceToday(a, now, sys);
  if (!occ || occ.getTime() > now.getTime()) return { owed: false };
  if (a.armedAt && occ.getTime() < a.armedAt) return { owed: false };
  const oneTime = (sys && Array.isArray(sys.repeatDays) ? sys.repeatDays : a.repeatDays).length === 0;
  if (oneTime && now.getTime() - occ.getTime() > ONE_TIME_OWED_MS) return { owed: false };
  if (!oneTime && dayKey(occ) !== dayKey(now)) return { owed: false };
  const morning = dayKey(occ);
  if (satisfied && satisfied[a.id] === morning) return { owed: false };
  return { owed: true, morning, at: occ.getTime() };
}

export function matchesSystem(a, sys){
  if (!sys) return false;
  const { hour, minute } = hm(a.time);
  if (sys.hour !== hour || sys.minute !== minute) return false;
  const x = [...(sys.repeatDays || [])].sort(), y = [...a.repeatDays].sort();
  return x.length === y.length && x.every((d, i) => d === y[i]);
}

export function sortAlarms(alarms){
  return [...alarms].sort((a, b) => a.time.localeCompare(b.time) || a.createdAt - b.createdAt);
}
