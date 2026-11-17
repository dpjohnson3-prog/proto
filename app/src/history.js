// Streak and stats history (v1.1, Premium to view; recorded for everyone so
// unlocking shows their past). Stored only on the device - nothing is sent
// anywhere. Pure, for scripts/verify-premium.mjs.
//
// A record is written once per finished REAL ring (never a practice run):
//   { day:'YYYY-MM-DD', alarmId, mode:'reps'|'timer'|'bail', reps, at:ms, ringAt:ms }
//
// Streak rule: only mornings an alarm actually rang count. A morning is won
// if any ring that day ended in reps or the timer hold, lost if every ring
// ended in a bail ("Just turn the alarm off"). Days with no ring - a weekend
// off, a holiday - neither extend nor break a streak.

export const MAX_RECORDS = 2000;

export function addRecord(list, rec){
  const out = [...(list || []), rec];
  return out.length > MAX_RECORDS ? out.slice(out.length - MAX_RECORDS) : out;
}

function dayOutcomes(records){
  const byDay = new Map();
  for (const r of records || []){
    const won = r.mode !== 'bail';
    byDay.set(r.day, (byDay.get(r.day) || false) || won);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));   // oldest first
}

export function summarize(records, now = new Date()){
  const days = dayOutcomes(records);
  let best = 0, run = 0;
  for (const [, won] of days){ run = won ? run + 1 : 0; best = Math.max(best, run); }
  let streak = 0;
  for (let i = days.length - 1; i >= 0 && days[i][1]; i--) streak++;
  const done = (records || []).filter(r => r.mode !== 'bail');
  const pushups = done.reduce((s, r) => s + (r.mode === 'reps' ? (r.reps || 0) : 0), 0);
  const delays = done.filter(r => r.ringAt && r.at >= r.ringAt).map(r => (r.at - r.ringAt) / 60000);
  const avgMinutes = delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null;

  const outcome = new Map(days);
  const last30 = [];
  for (let i = 29; i >= 0; i--){
    const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    last30.push({ day: k, state: outcome.has(k) ? (outcome.get(k) ? 'won' : 'lost') : null });
  }
  return { streak, best, mornings: days.filter(d => d[1]).length, pushups, avgMinutes, last30 };
}
