// Alarm scheduling on top of @capacitor/local-notifications.
//
// Why one-shot notifications instead of a repeating daily one:
// a daily repeat cannot have a single morning's occurrence cancelled, so
// finishing your reps at 06:30:40 would not stop the 06:31 and 06:32 rings.
// Instead we schedule explicit dates and top them up whenever the app opens.
//
// ---------------------------------------------------------------------------
// THE 64-SLOT BUDGET
// ---------------------------------------------------------------------------
// iOS keeps only the 64 soonest-firing pending local notifications per app.
// Bursts-per-morning (B) and days-ahead (D) therefore trade off directly:
//
//     B    D   B*D   +warn   ring coverage   disuse buffer
//     4   10    40     41        3 min          10 days     <- previous
//     6    9    54     55        5 min           9 days
//     8    7    56     57        7 min           7 days     <- CHOSEN
//    10    6    60     61        9 min           6 days
//    12    5    60     61       11 min           5 days
//
// Chosen B=8, D=7, +1 lapse warning = 57 pending, 7 slots of headroom.
//
// The reasoning: this app is necessarily opened on every morning it rings -
// you cannot dismiss it without opening it - so every normal morning re-arms
// a full window. D therefore buffers *disuse* (a trip, a holiday), not routine
// use. Under-ringing costs you on every single morning; a lapsed window costs
// you once, after D days of not touching the app, and is now announced rather
// than silent. So slots are better spent on B.
//
// 3 minutes of ringing was not enough for someone genuinely asleep. 8 bursts a
// minute apart gives 8 sounds across 7 minutes. BURST_GAP_MIN is the knob if
// you want the same 8 slots spread wider (gap 2 => 14 minutes, sparser).
//
// What this still is NOT: a guaranteed alarm. A genuinely reliable top-up
// needs either background refresh (BGTaskScheduler - iOS decides if and when
// it runs, so it reduces the lapse risk without removing it) or a push server
// (reliable, but needs a backend, APNs certificates and the device token
// plumbing). Both are real machinery; see README before committing to either.
// ---------------------------------------------------------------------------
import { LocalNotifications } from '@capacitor/local-notifications';
import { loadScheduled, saveScheduled, loadSatisfied, saveSatisfied } from './storage.js';

export const RING_BURST     = 8;   // notifications per morning
export const BURST_GAP_MIN  = 1;   // minutes between them
export const DAYS_AHEAD     = 7;   // mornings scheduled in advance
export const WARN_LEAD_DAYS = 2;   // warn this many days before the last one
export const WARN_HOUR      = 20;  // ...at this hour, when someone can act
export const RESERVED_SLOTS = 1;   // the lapse warning
export const IOS_PENDING_CAP = 64;

// How long after the first burst a set may still be in progress. Inside this
// window the schedule is left alone rather than rebuilt, so notifications that
// are about to fire are never cancelled out from under a live ring.
export const RING_GRACE_MIN = 45;

// TODO(sound): drop your alarm audio in as ios/App/App/alarm.wav and keep this
// name in sync. See ios-assets/sounds/README.md. Until that file exists iOS
// falls back to the default notification sound.
export const ALARM_SOUND = 'alarm.wav';

const RING_ID_BASE = 42000;   // one id per burst
const WARN_ID      = 41000;   // distinct range: never treated as a ring

export function slotsUsed(){ return RING_BURST * DAYS_AHEAD + RESERVED_SLOTS; }

// Local calendar day, used as the identity of "a morning".
export function dayKey(d){
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

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

// ---------------------------------------------------------------------------
// Pure planning core. No plugin calls, so it is fully testable off-device -
// which matters because notification delivery itself is not.
// ---------------------------------------------------------------------------

// Up to DAYS_AHEAD mornings of bursts. A morning whose key matches satisfiedKey
// is skipped entirely: its reps are done, and rebuilding the schedule must not
// resurrect rings it already cancelled.
export function plan(hhmm, from = new Date(), satisfiedKey = null){
  const [h, m] = hhmm.split(':').map(Number);
  const mornings = [];
  for (let day = 0; day <= DAYS_AHEAD && mornings.length < DAYS_AHEAD; day++){
    const base = new Date(from);
    base.setDate(base.getDate() + day);
    base.setHours(h, m, 0, 0);
    const key = dayKey(base);
    if (key === satisfiedKey) continue;
    const times = [];
    for (let b = 0; b < RING_BURST; b++){
      const at = new Date(base.getTime() + b * BURST_GAP_MIN * 60000);
      if (at.getTime() > from.getTime() + 1000) times.push(at);
    }
    if (times.length) mornings.push({ key, times });
  }
  return mornings;
}

// The evening WARN_LEAD_DAYS before the last armed morning, or null if that
// moment has already passed.
export function warnTimeFor(mornings, from = new Date()){
  if (!mornings.length) return null;
  const last = mornings[mornings.length - 1];
  const at = new Date(last.times[0]);
  at.setDate(at.getDate() - WARN_LEAD_DAYS);
  at.setHours(WARN_HOUR, 0, 0, 0);
  return at.getTime() > from.getTime() + 1000 ? at : null;
}

export function armedThrough(mornings){
  if (!mornings.length) return null;
  const last = mornings[mornings.length - 1].times;
  return new Date(last[last.length - 1]);
}

// Is a ring for `now`'s morning potentially still live? Used to leave the
// schedule untouched while someone is mid-set.
export function inRingWindow(hhmm, now = new Date()){
  const [h, m] = hhmm.split(':').map(Number);
  const start = new Date(now); start.setHours(h, m, 0, 0);
  const span = (RING_BURST - 1) * BURST_GAP_MIN + RING_GRACE_MIN;
  const end = start.getTime() + span * 60000;
  return now.getTime() >= start.getTime() && now.getTime() < end;
}

export function buildNotifications(hhmm, goal, from = new Date(), satisfiedKey = null){
  const mornings = plan(hhmm, from, satisfiedKey);
  const reps = goal + (goal === 1 ? ' push-up' : ' push-ups');
  const notifications = [];
  let i = 0;
  for (const mo of mornings){
    for (const at of mo.times){
      notifications.push({
        id: RING_ID_BASE + (i++),
        title: 'Time to get up',
        body: reps + ' to turn it off.',
        schedule: { at, allowWhileIdle: true },
        sound: ALARM_SOUND,
        // 'timeSensitive' breaks through most Focus modes and is a self-serve
        // Xcode capability (Signing & Capabilities -> Time Sensitive
        // Notifications). It is NOT 'critical': that one needs the Critical
        // Alerts entitlement, which Apple grants by application only, and is
        // the only way to override the silent switch and the volume setting.
        interruptionLevel: 'timeSensitive',
        extra: { dawn: true, kind: 'ring', morning: mo.key, at: at.toISOString() }
      });
    }
  }
  const through = armedThrough(mornings);
  const warnAt = warnTimeFor(mornings, from);
  if (warnAt && through){
    // Converts a silent lapse into a loud one. Costs exactly one slot.
    notifications.push({
      id: WARN_ID,
      title: 'Dawn Alarm is about to lapse',
      body: 'It stops ringing after ' + through.toLocaleDateString([], {
        weekday: 'long', month: 'short', day: 'numeric'
      }) + '. Open the app to keep it armed.',
      schedule: { at: warnAt, allowWhileIdle: true },
      interruptionLevel: 'active',
      extra: { dawn: true, kind: 'warn' }
    });
  }
  return {
    notifications,
    rings: notifications.filter(n => n.extra.kind === 'ring'),
    mornings,
    first: mornings.length ? mornings[0].times[0] : null,
    through,
    warnAt
  };
}

// ---------------------------------------------------------------------------
// The ringer advisory.
//
// Investigated whether the silent switch or ringer volume can be READ from a
// Capacitor app, so this could warn only when actually muted. They cannot,
// reliably:
//
//  - iOS exposes no public API for the ring/silent switch. Every plugin that
//    claims to detect it (@capgo/capacitor-mute, @capawesome/capacitor-silent-
//    mode) uses the same heuristic: play a short silent sound and time how long
//    it takes. capawesome's own docs say it "may be inaccurate while other
//    audio is playing or when the audio session category overrides the switch";
//    capgo's note that their underlying Mute library "is not configured as
//    Apple expect anymore" since Xcode 14.
//  - Ringer volume is not readable at all. AVAudioSession.outputVolume reports
//    the media volume, which is a different slider from the one that governs
//    notification sounds.
//  - Decisively: on iOS the state can only be sampled while the app is in the
//    FOREGROUND. capawesome's listener polls on a timer and pauses in the
//    background. The alarm fires when the app is closed, so even a perfect
//    reading at arm time says nothing about the switch position at 06:30 -
//    which is the only moment that matters.
//
// A detector that is wrong in either direction is worse than none: "your ringer
// is on" when it is off is exactly the silent failure this is meant to prevent.
// So this is a plain, permanent advisory instead, shown for as long as the
// alarm is armed. It never blocks arming - arming a silent alarm is allowed,
// being surprised by it is not.
export const RINGER_ADVISORY =
  'Leave the ringer on. This rings through Focus and Do Not Disturb, but the ' +
  'silent switch and the volume still win - iOS gives apps no way to ring ' +
  'past those, and no way to check them while the app is closed.';

// Whether the ring screen may offer a one-tap way back to alarm setup.
// Only a test run may. When a real alarm is ringing, this screen IS the
// dismissal gate: a back arrow would reduce the rep requirement to a tap. The
// escape-hatch sheet remains the deliberate exit from both.
export function backArrowVisible({ real }){ return !real; }

// Whether a ring event should actually take over the screen. Extracted so the
// safety-critical decision is testable without a device.
export function shouldRing({ setInProgress, real, morning, satisfiedKey }){
  // A later burst must never yank someone out of the set that would dismiss it.
  if (setInProgress) return { ring: false, reason: 'set-in-progress' };
  // A notification already delivered to Notification Center can be tapped long
  // after the reps were done. That morning is settled.
  if (real && morning && morning === satisfiedKey){
    return { ring: false, reason: 'already-satisfied' };
  }
  return { ring: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Stateful wrappers
// ---------------------------------------------------------------------------

async function cancelOurs(){
  try {
    const pending = await LocalNotifications.getPending();
    const ours = (pending.notifications || []).filter(
      n => n.id === WARN_ID || n.id >= RING_ID_BASE);
    if (ours.length){
      await LocalNotifications.cancel({ notifications: ours.map(n => ({ id: n.id })) });
    }
  } catch (e){}
}

export async function arm(hhmm, goal, now = new Date()){
  const satisfiedKey = await loadSatisfied();
  const built = buildNotifications(hhmm, goal, now, satisfiedKey);
  await cancelOurs();
  if (built.notifications.length){
    await LocalNotifications.schedule({ notifications: built.notifications });
  }
  await saveScheduled(built.rings.map(n => ({
    id: n.id, at: n.extra.at, morning: n.extra.morning
  })));
  return built;
}

export async function disarm(){
  await cancelOurs();
  await saveScheduled([]);
}

// THE dismissal point. Called only when a set is actually completed - reps
// finished, the 30-second timer run down, or a deliberate bail. Never on a
// notification tap, never on the app merely opening, never on a swipe (iOS
// does not even report those), and never on a "Try it now" test run.
export async function markSatisfied(morningKey){
  await saveSatisfied(morningKey);
  const list = await loadScheduled();
  const doomed = list.filter(e => e.morning === morningKey);
  if (doomed.length){
    try { await LocalNotifications.cancel({ notifications: doomed.map(e => ({ id: e.id })) }); }
    catch (e){}
  }
  await saveScheduled(list.filter(e => e.morning !== morningKey));
  return doomed.length;
}

export async function satisfiedKey(){ return loadSatisfied(); }

// Rebuild the rolling window. Safe on every app open, with one exception: if a
// ring for an unsatisfied morning could still be live, leave the schedule
// alone rather than cancel and re-add notifications that are about to fire.
export async function topUp(hhmm, goal, now = new Date()){
  const key = dayKey(now);
  const satisfied = await loadSatisfied();
  if (satisfied !== key && inRingWindow(hhmm, now)) return null;
  return arm(hhmm, goal, now);
}

export async function pendingCount(){
  try { return ((await LocalNotifications.getPending()).notifications || []).length; }
  catch (e){ return 0; }
}
