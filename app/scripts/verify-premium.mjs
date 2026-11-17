// v1.1: multiple alarms, free/Premium rules, v1.0 grandfathering, StoreKit
// copy, streaks - plus structural checks that Premium can never get between
// someone and an alarm. Pure modules only; runs in plain Node.
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import * as A from '../src/alarms.js';
import * as P from '../src/premium.js';
import { summarize, addRecord, MAX_RECORDS } from '../src/history.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, ok, detail){ ok ? pass++ : fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail && !ok ? '  [' + detail + ']' : '')); }
const at = (s) => new Date(s);
const ms = (s) => new Date(s).getTime();

console.log('\n== v1.0 -> v1.1 migration ==');
const v10 = { time: '06:45', goal: 25, armed: true, sound: 'reveille', alarmBackend: 'alarmkit', repeatDays: [1, 2, 3, 4, 5] };
const m = A.migrateFromSettings(v10, ms('2026-11-20T21:00:00'));
check('one alarm', m.length === 1);
check('keeps the SAME id as the live system alarm (dawn-daily)', m[0].id === 'dawn-daily');
check('keeps time, reps, sound and days exactly', m[0].time === '06:45' && m[0].goal === 25 && m[0].sound === 'reveille' && m[0].repeatDays.join() === '1,2,3,4,5');
check('an armed 1.0 alarm stays on', m[0].enabled === true);
check('...and is marked for a one-time native refresh (Stop carries its id)', m[0].nativeRev < A.NATIVE_REV);
check('a disarmed 1.0 alarm migrates off', A.migrateFromSettings({ ...v10, armed: false })[0].enabled === false);
check('no saved 1.0 settings -> no alarms', A.migrateFromSettings(null).length === 0);
check('pre-repeat-days 1.0 settings default to every day', A.migrateFromSettings({ time: '06:30', goal: 10, armed: true })[0].repeatDays.length === 7);

console.log('\n== free vs Premium ==');
const free1 = { ...A.newAlarm({ id: 'f' }), enabled: true };
const custom = { ...A.newAlarm({ id: 'c' }), goal: 20, enabled: true };
check('free: the first alarm can be added', A.canAdd([], false));
check('free: a second alarm needs Premium', !A.canAdd([free1], false));
check('Premium: unlimited alarms', A.canAdd([free1, custom, free1], true));
check('free: default alarm is editable (time)', A.canEdit(free1, [free1], false));
check('free: custom reps need Premium', A.premiumChange({ ...free1, goal: 11 }) === 'reps');
check('free: other sounds need Premium', A.premiumChange({ ...free1, sound: 'dawn' }) === 'sound');
check('free: specific days need Premium', A.premiumChange({ ...free1, repeatDays: [1, 2, 3, 4, 5] }) === 'days');
check('free: a one-time alarm is a repeat schedule (Premium)', A.premiumChange({ ...free1, repeatDays: [] }) === 'days');
check('free: defaults are free', A.premiumChange(free1) === null);
check('defaults are 10 reps and Chime', A.DEFAULT_GOAL === 10 && A.DEFAULT_SOUND === 'chime');

console.log('\n== Premium ends: alarms keep ringing, edits lock ==');
const lapsed = [custom, { ...free1 }];
check('a customised alarm cannot be edited without Premium', !A.canEdit(custom, lapsed, false));
check('with several alarms, even a default one is locked', !A.canEdit(free1, lapsed, false));
check('a customised alarm cannot be turned back ON', !A.canEnable({ ...custom, enabled: false }, lapsed, false));
check('a default alarm can be turned on if it is the only one on', A.canEnable({ ...free1, enabled: false }, [{ ...custom, enabled: false }, { ...free1, enabled: false }], false));
check('...but not as a second enabled alarm', !A.canEnable({ ...free1, id: 'x', enabled: false }, [free1, { ...free1, id: 'x', enabled: false }], false));

console.log('\n== owed push-ups, per alarm ==');
const daily = { ...A.newAlarm({ id: 'd' }), time: '06:30', enabled: true, armedAt: ms('2026-11-01T12:00:00') };
check('after the alarm time, unsatisfied: owed', A.owedState(daily, at('2026-11-20T06:40:00'), {}).owed);
check('before the alarm time: not owed', !A.owedState(daily, at('2026-11-20T06:20:00'), {}).owed);
check('satisfied this morning: not owed', !A.owedState(daily, at('2026-11-20T09:00:00'), { d: '2026-11-20' }).owed);
check('satisfied YESTERDAY does not cover today', A.owedState(daily, at('2026-11-20T09:00:00'), { d: '2026-11-19' }).owed);
check('disabled: never owed', !A.owedState({ ...daily, enabled: false }, at('2026-11-20T07:00:00'), {}).owed);
const weekdays = { ...daily, repeatDays: [1, 2, 3, 4, 5] };
check('weekday alarm on a Saturday: NOT owed', !A.owedState(weekdays, at('2026-11-21T09:00:00'), {}).owed);
check('weekday alarm on a Friday: owed', A.owedState(weekdays, at('2026-11-20T09:00:00'), {}).owed);
const lateArm = { ...daily, armedAt: ms('2026-11-20T21:00:00') };
check('turned on at 21:00: this morning\'s 06:30 never rang, so not owed', !A.owedState(lateArm, at('2026-11-20T21:05:00'), {}).owed);
check('...but tomorrow\'s is', A.owedState(lateArm, at('2026-11-21T06:31:00'), {}).owed);
const once = { ...daily, repeatDays: [], armedAt: ms('2026-11-20T21:00:00') };
check('one-time set at 21:00 for 06:30: not owed that evening', !A.owedState(once, at('2026-11-20T23:00:00'), {}).owed);
check('one-time: owed after it rings the next morning', A.owedState(once, at('2026-11-21T06:45:00'), {}).owed);
check('one-time: no longer owed 12+ hours later', !A.owedState(once, at('2026-11-21T19:00:00'), {}).owed);
check('the SYSTEM\'s schedule wins over saved settings', A.owedState({ ...daily, time: '09:00' }, at('2026-11-20T06:40:00'), {}, { hour: 6, minute: 30, repeatDays: A.EVERY_DAY }).owed);
const two = [daily, { ...daily, id: 'e', time: '07:00' }];
check('two alarms are tracked separately: 06:40 owes only the 06:30 one',
  A.owedState(two[0], at('2026-11-20T06:40:00'), {}).owed && !A.owedState(two[1], at('2026-11-20T06:40:00'), {}).owed);
check('satisfying 06:30 does not satisfy the 07:00 backup',
  A.owedState(two[1], at('2026-11-20T07:05:00'), { d: '2026-11-20' }).owed);

console.log('\n== system matching ==');
check('identical schedule matches', A.matchesSystem(daily, { hour: 6, minute: 30, repeatDays: [6, 5, 4, 3, 2, 1, 0] }));
check('changed time does not', !A.matchesSystem(daily, { hour: 6, minute: 31, repeatDays: A.EVERY_DAY }));
check('changed days do not', !A.matchesSystem(daily, { hour: 6, minute: 30, repeatDays: [1] }));
check('missing does not', !A.matchesSystem(daily, undefined));

console.log('\n== v1.0 users: Premium for life ==');
check('build "2" (Dawn 1.0) is grandfathered', P.isLegacyBuild('2'));
check('build "1" is grandfathered', P.isLegacyBuild('1'));
check('sandbox/TestFlight "1.0" is NOT', !P.isLegacyBuild('1.0'));
check('v1.1 build "3" is not', !P.isLegacyBuild('3'));
check('unknown is not', !P.isLegacyBuild(null));
check('legacy is Premium with nothing purchased', P.resolveAccess({ legacy: true, live: { active: false }, cache: null, now: 0 }).premium);

console.log('\n== entitlement + offline cache ==');
const NOW = ms('2026-11-20T08:00:00'), DAY = 86400000;
check('live active -> Premium', P.resolveAccess({ legacy: false, live: { active: true }, cache: null, now: NOW }).premium);
check('live inactive overrides an old active cache', !P.resolveAccess({ legacy: false, live: { active: false }, cache: { active: true, lifetime: true }, now: NOW }).premium);
check('offline: cached Lifetime is trusted forever', P.cacheTrusted({ active: true, lifetime: true }, NOW + 9999 * DAY));
check('offline: cached subscription trusted until expiry + slack', P.cacheTrusted({ active: true, expires: NOW - 2 * DAY }, NOW));
check('offline: not after that', !P.cacheTrusted({ active: true, expires: NOW - 4 * DAY }, NOW));
check('offline, no cache: free', !P.resolveAccess({ legacy: false, live: null, cache: null, now: NOW }).premium);

console.log('\n== paywall copy (StoreKit prices only) ==');
const prods = [
  { id: P.YEARLY, displayPrice: '$29.99', price: 29.99, pricePerMonth: '$2.50', trial: { unit: 'week', value: 1 }, trialEligible: true },
  { id: P.MONTHLY, displayPrice: '$4.99', price: 4.99 },
  { id: P.LIFETIME, displayPrice: '$59.99', price: 59.99 }
];
let c = P.planCopy(prods);
check('order: Yearly, Monthly - Lifetime is never sold', c.plans.map(p => p.id).join() === [P.YEARLY, P.MONTHLY].join());
check('yearly reads "7 days free, then $29.99/year"', c.plans[0].line === '7 days free, then $29.99/year', c.plans[0].line);
check('yearly CTA "Start free trial"', c.plans[0].cta === 'Start free trial');
check('yearly badge "Save 50%"', c.plans[0].badge === 'Save 50%');
check('auto-renew disclosure on subscriptions', /renews automatically/i.test(c.plans[0].fine) && /renews automatically/i.test(c.plans[1].fine));
check('...and the post-trial price', c.plans[0].fine.includes('$29.99 per year'));
check('no plan offers Lifetime even when StoreKit returns it', !c.plans.some(p => p.id === P.LIFETIME || /lifetime|forever/i.test(p.title + p.cta)));
c = P.planCopy([{ ...prods[0], trialEligible: false }, prods[1], prods[2]]);
check('trial already used: no "free" on yearly', !/free/i.test(c.plans[0].line + c.plans[0].cta + c.plans[0].fine));
c = P.planCopy([{ ...prods[0], displayPrice: '29,99 €', pricePerMonth: '2,50 €' }, { ...prods[1], displayPrice: '4,99 €' }, prods[2]]);
check('localized prices are shown verbatim', c.plans[0].line.includes('29,99 €') && c.plans[1].line.includes('4,99 €'));
check('cancelled purchase shows no message', P.purchaseMessage('cancelled') === '');
check('network failure explains itself', /connection/i.test(P.purchaseMessage('network')));
check('Ask to Buy says it is waiting', /approval/i.test(P.purchaseMessage('pending')));
check('restore with nothing found says so', /No Dawn Premium purchase/.test(P.restoreMessage({ status: 'ok', active: false })));
check('Terms is Apple\'s standard EULA', P.TERMS_URL === 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/');
check('Privacy is on dawn-alarm.vercel.app', P.PRIVACY_URL === 'https://dawn-alarm.vercel.app/privacy');

console.log('\n== streak & stats ==');
const r = (day, mode, reps = 10, delayMin = 3) => ({ day, mode, reps, alarmId: 'd', at: ms(day + 'T06:30:00') + delayMin * 60000, ringAt: ms(day + 'T06:30:00') });
let s = summarize([r('2026-11-17', 'reps'), r('2026-11-18', 'timer'), r('2026-11-20', 'reps')], at('2026-11-20T09:00:00'));
check('a day with no ring does not break the streak', s.streak === 3, s.streak);
s = summarize([r('2026-11-17', 'reps'), r('2026-11-18', 'bail'), r('2026-11-19', 'reps')], at('2026-11-19T09:00:00'));
check('a bail breaks it', s.streak === 1 && s.best === 1);
s = summarize([r('2026-11-18', 'bail', 0), r('2026-11-18', 'reps', 12)], at('2026-11-18T09:00:00'));
check('a won ring and a bailed ring the same day = won', s.streak === 1);
check('push-ups total counts reps only', s.pushups === 12);
check('30-day strip', s.last30.length === 30 && s.last30[29].state === 'won');
check('history is capped', addRecord(new Array(MAX_RECORDS).fill(r('2026-01-01', 'reps')), r('2026-11-20', 'reps')).length === MAX_RECORDS);

console.log('\n== Premium can never get between someone and an alarm (structure) ==');
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const fn = (name, next) => main.slice(main.indexOf(name), next ? main.indexOf(next, main.indexOf(name) + 1) : undefined);
const ring = fn('async function enterRing', '\n// ----');
check('a ring closes the paywall', ring.includes('closePaywall('));
check('a ring closes settings', ring.includes('closeSettings()'));
const off = fn('async function turnOff', '\n// ');
check('turning an alarm OFF never opens the paywall', !off.includes('openPaywall') && !off.includes('premiumGate'));
check('...but refuses while it is ringing or owed', off.includes('refuseIfOwed('));
check('...and cancels in the system BEFORE flipping enabled',
  off.indexOf('alarmKit.cancelAlarm(') > -1 && off.indexOf('alarmKit.cancelAlarm(') < off.indexOf('a.enabled = false'));
const del = fn('async function deleteDraft', '\n// ----');
check('deleting never opens the paywall', !del.includes('openPaywall') && !del.includes('premiumGate'));
check('...but refuses while owed, and cancels in the system first',
  del.includes('refuseIfOwed(') && del.indexOf('alarmKit.cancelAlarm(') < del.indexOf('alarms.filter('));
const owedFn = fn('async function refuseIfOwed', '\n// ');
check('refuseIfOwed refuses during a real ring', /activeRing && activeRing\.real/.test(owedFn));
const rec = fn('async function reconcile', '\n// ');
check('reconcile never cancels on an unknown system state', /if \(sys === null\) return;/.test(rec));
check('...never cancels when the saved list was unreadable', rec.includes('alarmsUnreadable'));
check('...and never touches Premium', !/premium|openPaywall/.test(rec));
check('reconcile + routing run on launch and every foreground', (main.match(/await syncAndRoute\(\)/g) || []).length >= 2);
const boot = fn('async function boot', null);
check('StoreKit status is fetched AFTER the alarm is routed',
  boot.indexOf('store.refresh().then(') > boot.indexOf('if (!resumed) showHome();'));
check('store init at launch is time-capped', /Promise\.race\(\[store\.init\(\)/.test(boot));
const finish = main.slice(main.indexOf('onFinish: async'), main.indexOf('wireUI();', main.indexOf('onFinish: async')));
check('only a REAL ring is recorded / satisfies anything', finish.indexOf('if (!ring || !ring.real) return;') < finish.indexOf('addRecord('));
check('the morning paywall is never shown after a bail or a practice run',
  /mode === 'bail'/.test(fn("$('againBtn').onclick", "\n}")) && /lastRealFinish = mode/.test(finish));
check('practice ("Try it now") is never gated',
  !/premiumGate|openPaywall/.test(fn("$('testBtn').onclick", "$('ringEscape')")));
check('the StoreKit status is never consulted on the ring path', !/store\.|premium\(\)/.test(ring));

console.log('\n== native ==');
const swift = fs.readFileSync(path.join(ROOT, 'ios/App/App/DawnStore.swift'), 'utf8');
check('no third-party SDK: StoreKit only', !/RevenueCat|Purchases|import (?!Foundation|Capacitor|StoreKit|UIKit)/.test(swift));
check('verified transactions only', /case \.verified\(let t\) = result, t\.revocationDate == nil/.test(swift));
check('Lifetime OR a subscription unlocks', /lifetime \|\| best != nil \|\| inGrace/.test(swift));
check('listens to Transaction.updates from launch and finishes them', /for await result in Transaction\.updates/.test(swift) && /transaction\.finish\(\)/.test(swift));
check('restore = AppStore.sync()', /AppStore\.sync\(\)/.test(swift));
check('manage = showManageSubscriptions', /showManageSubscriptions/.test(swift));
check('code redemption sheet', /presentOfferCodeRedeemSheet/.test(swift));
check('v1.0 detection reads a VERIFIED AppTransaction', /AppTransaction\.shared/.test(swift) && /guard case \.verified\(let t\) = result/.test(swift));
const ak = fs.readFileSync(path.join(ROOT, 'ios/App/App/DawnAlarmKit.swift'), 'utf8');
check('each alarm\'s Stop carries its own id', /stopIntent: DawnAlarmStopIntent\(alarmID: callerId\)/.test(ak));
check('a v1.0 Stop (no id) still decodes', /var alarmID: String\?/.test(ak));
check('follow-ups are per alarm', /scheduleFollowUp\(for owner: String/.test(ak) && /kFollowUps/.test(ak));
check('cancelling one alarm cancels only ITS follow-up', /cancelFollowUp\(for: callerId\)/.test(ak) && !/cancelFollowUpIfAny/.test(ak));
check('a finished set cancels every follow-up', /func completeMission[\s\S]{0,200}cancelAllFollowUps\(\)/.test(ak));
const kit = fs.readFileSync(path.join(ROOT, 'ios/App/Dawn.storekit'), 'utf8');
const kj = JSON.parse(kit);
const subs = kj.subscriptionGroups[0].subscriptions;
check('StoreKit config: group "Dawn Premium"', kj.subscriptionGroups[0].name === 'Dawn Premium');
check('StoreKit config: monthly $4.99', subs.some(x => x.productID === P.MONTHLY && x.displayPrice === '4.99' && x.recurringSubscriptionPeriod === 'P1M'));
check('StoreKit config: yearly $29.99 + 1-week free trial', subs.some(x => x.productID === P.YEARLY && x.displayPrice === '29.99' && x.introductoryOffer && x.introductoryOffer.paymentMode === 'free' && x.introductoryOffer.subscriptionPeriod === 'P1W'));
check('StoreKit config: yearly ranked above monthly', subs.find(x => x.productID === P.YEARLY).groupNumber < subs.find(x => x.productID === P.MONTHLY).groupNumber);
check('StoreKit config: Lifetime $59.99 non-consumable', kj.products.some(x => x.productID === P.LIFETIME && x.type === 'NonConsumable' && x.displayPrice === '59.99'));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const pw = html.slice(html.indexOf('id="paywall"'));
check('paywall: Restore Purchases', pw.includes('id="pwRestore"'));
check('paywall: Terms of Use + Privacy Policy', pw.includes('id="pwTerms"') && pw.includes('id="pwPrivacy"'));
check('paywall: redeem code', pw.includes('id="pwRedeem"'));
check('paywall: no hardcoded price in the markup', !/\$\d|\d+\.99/.test(pw));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
