// Alarm scheduling on top of @capacitor/local-notifications.
//
// Why one-shot notifications instead of a repeating daily one:
// a daily repeat cannot have a single morning's occurrence cancelled, so
// finishing your reps at 06:30:40 would not stop the 06:31 and 06:32 rings.
// Instead we schedule explicit dates and top them up whenever the app opens.
//
// iOS limits an app to 64 pending local notifications, so RING_BURST *
// DAYS_AHEAD must stay under that. 4 * 10 = 40 leaves headroom.
import { LocalNotifications } from '@capacitor/local-notifications';
import { loadScheduled, saveScheduled } from './storage.js';

export const RING_BURST    = 4;    // notifications per morning
export const BURST_GAP_MIN = 1;    // minutes between them
export const DAYS_AHEAD    = 10;   // mornings scheduled in advance
export const IOS_PENDING_CAP = 64;

// The window around a ring in which "I finished my reps" should silence the
// rest of that morning's burst.
const RING_WINDOW_MIN = 30;

// TODO(sound): drop your alarm audio in as ios/App/App/alarm.wav and keep this
// name in sync. See ios-assets/sounds/README.md. Until that file exists iOS
// falls back to the default notification sound.
export const ALARM_SOUND = 'alarm.wav';

const ID_BASE = 42000;

export async function checkPermission(){
  try { return (await LocalNotifications.checkPermissions()).display; }
  catch (e){ return 'prompt'; }
}

// Asked at arm time, not at launch: a permission prompt on first open, before
// the person knows what the app does, is the reliable way to get denied.
export async function requestPermission(){
  try { return (await LocalNotifications.requestPermissions()).display; }
  catch (e){ return 'denied'; }
}

// Every ring datetime for the next DAYS_AHEAD mornings, skipping any already past.
export function occurrences(hhmm, from = new Date()){
  const [h, m] = hhmm.split(':').map(Number);
  const out = [];
  for (let day = 0; day <= DAYS_AHEAD; day++){
    const base = new Date(from);
    base.setDate(base.getDate() + day);
    base.setHours(h, m, 0, 0);
    for (let b = 0; b < RING_BURST; b++){
      const at = new Date(base.getTime() + b * BURST_GAP_MIN * 60000);
      if (at.getTime() > from.getTime() + 1000) out.push(at);
    }
    if (out.length >= RING_BURST * DAYS_AHEAD) break;
  }
  return out.slice(0, RING_BURST * DAYS_AHEAD);
}

export async function arm(hhmm, goal){
  await disarm();
  const times = occurrences(hhmm);
  const notifications = times.map((at, i) => ({
    id: ID_BASE + i,
    title: 'Time to get up',
    body: goal + (goal === 1 ? ' push-up' : ' push-ups') + ' to turn it off.',
    schedule: { at, allowWhileIdle: true },
    sound: ALARM_SOUND,
    // 'timeSensitive' breaks through most Focus modes and is a self-serve
    // Xcode capability (Signing & Capabilities -> Time Sensitive
    // Notifications). It is NOT 'critical': that one needs the Critical Alerts
    // entitlement, which Apple grants by application only, and is the only way
    // to override the physical silent switch and the volume setting.
    interruptionLevel: 'timeSensitive',
    extra: { dawn: true, at: at.toISOString() }
  }));
  await LocalNotifications.schedule({ notifications });
  await saveScheduled(notifications.map(n => ({ id: n.id, at: n.extra.at })));
  return times[0] || null;
}

export async function disarm(){
  try {
    const pending = await LocalNotifications.getPending();
    const ours = (pending.notifications || []).filter(n => n.id >= ID_BASE);
    if (ours.length) await LocalNotifications.cancel({ notifications: ours.map(n => ({ id: n.id })) });
  } catch (e){}
  await saveScheduled([]);
}

// Silence the rest of this morning's burst once the reps are done.
export async function silenceThisMorning(){
  const list = await loadScheduled();
  if (!list.length) return;
  const now = Date.now(), win = RING_WINDOW_MIN * 60000;
  const doomed = list.filter(e => Math.abs(new Date(e.at).getTime() - now) <= win);
  if (doomed.length){
    try { await LocalNotifications.cancel({ notifications: doomed.map(e => ({ id: e.id })) }); }
    catch (e){}
  }
  await saveScheduled(list.filter(e => !doomed.includes(e)));
}

// Keep the rolling window full. Safe to call on every app open.
export async function topUp(hhmm, goal){
  const list = await loadScheduled();
  const future = list.filter(e => new Date(e.at).getTime() > Date.now());
  if (future.length < RING_BURST * 2) return arm(hhmm, goal);
  return future.length ? new Date(future[0].at) : null;
}

export async function pendingCount(){
  try { return ((await LocalNotifications.getPending()).notifications || []).length; }
  catch (e){ return 0; }
}
