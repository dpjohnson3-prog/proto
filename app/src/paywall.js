// The Dawn Premium paywall. openPaywall() resolves true once Premium is
// active (purchase, restore or a redeemed code), false if dismissed.
//
// Every price shown is StoreKit's own localized string for this buyer's
// storefront - never a constant. main.js closes this the moment a real alarm
// starts ringing: it may never sit on top of a ring.
import * as store from './store.js';
import { planCopy, purchaseMessage, restoreMessage, YEARLY, TERMS_URL, PRIVACY_URL } from './premium.js';

const $ = (id) => document.getElementById(id);

const HEADLINES = {
  alarms:   ['More than one morning.', 'Set as many alarms as you need with Dawn Premium.'],
  reps:     ['Set your own number.', 'Custom rep counts are part of Dawn Premium.'],
  sound:    ['Wake up to your sound.', 'Every alarm sound is part of Dawn Premium.'],
  days:     ['Your schedule, not ours.', 'Weekdays, weekends, one-offs: repeat schedules are part of Dawn Premium.'],
  stats:    ['See your streak.', 'Your streak and morning history are part of Dawn Premium.'],
  edit:     ['Keep your mornings.', 'Your alarms keep ringing as set. Changing them needs Dawn Premium. Turning one off is always free.'],
  morning:  ['You got up.', 'Do it again tomorrow, and every morning after, with everything Dawn has.'],
  settings: ['Get up the first time.', 'An alarm only push-ups can turn off.']
};

let resolver = null;
let copy = null;
let selected = YEARLY;
let busy = false;
let unsub = null;

export const isOpen = () => resolver !== null;

export function openPaywall({ reason = 'settings' } = {}){
  if (resolver) return Promise.resolve(false);
  const [title, lede] = HEADLINES[reason] || HEADLINES.settings;
  $('pwTitle').textContent = title;
  $('pwLede').textContent = lede;
  $('pwTerms').href = TERMS_URL;
  $('pwPrivacy').href = PRIVACY_URL;
  setMsg('');
  const el = $('paywall');
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('on'));
  // A code redeemed in Apple's sheet, an Ask-to-Buy approval, or a purchase
  // finishing in the background all land here.
  unsub = store.onChange(() => { if (resolver && !busy && store.isPremium()) succeed(); });
  load();
  return new Promise((res) => { resolver = res; });
}

export function closePaywall(result = false){
  if (!resolver) return;
  const res = resolver;
  resolver = null;
  busy = false;
  if (unsub){ unsub(); unsub = null; }
  const el = $('paywall');
  el.classList.remove('on');
  setTimeout(() => { if (!resolver) el.hidden = true; }, 260);
  res(result);
}

async function load(){
  copy = null;
  renderLoading();
  const r = await store.loadProducts();
  if (!resolver) return;
  if (!r.ok){ renderError(r.message); return; }
  copy = planCopy(r.products);
  if (!copy.plans.length){ renderError('Plans aren’t available right now. Please try again later.'); return; }
  selected = copy.plans.some(p => p.id === YEARLY) ? YEARLY : copy.plans[0].id;   // yearly pre-selected
  renderPlans();
}

function renderLoading(){
  const box = $('pwPlans');
  box.textContent = '';
  for (let i = 0; i < 3; i++){
    const d = document.createElement('div');
    d.className = 'pwPlan pwSkeleton';
    d.setAttribute('aria-hidden', 'true');
    box.appendChild(d);
  }
  const cta = $('pwCta');
  cta.disabled = true;
  cta.textContent = 'Loading plans…';
  cta.onclick = null;
  $('pwFine').textContent = '';
}

function renderError(message){
  $('pwPlans').textContent = '';
  setMsg(message, 'error');
  const cta = $('pwCta');
  cta.disabled = false;
  cta.textContent = 'Try again';
  cta.onclick = () => { setMsg(''); load(); };
  $('pwFine').textContent = '';
}

function renderPlans(){
  const box = $('pwPlans');
  box.textContent = '';
  for (const c of copy.plans){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pwPlan';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(selected === c.id));
    b.innerHTML =
      '<span class="pwRadio" aria-hidden="true"></span>' +
      '<span class="pwPlanText"><span class="pwPlanTitle"></span><span class="pwPlanLine"></span></span>' +
      '<span class="pwPlanSub"></span>';
    const title = b.querySelector('.pwPlanTitle');
    title.textContent = c.title;
    if (c.badge){
      const badge = document.createElement('em');
      badge.className = 'pwBadge';
      badge.textContent = c.badge;
      title.appendChild(badge);
    }
    b.querySelector('.pwPlanLine').textContent = c.line;
    b.querySelector('.pwPlanSub').textContent = c.sub || '';
    b.onclick = () => { if (busy) return; selected = c.id; renderPlans(); };
    box.appendChild(b);
  }
  const plan = copy.plans.find(p => p.id === selected);
  const cta = $('pwCta');
  cta.disabled = false;
  cta.textContent = plan.cta;
  cta.onclick = buy;
  $('pwFine').textContent = plan.fine;
}

function setBusy(on, label){
  busy = on;
  const cta = $('pwCta');
  cta.disabled = on;
  cta.setAttribute('aria-busy', String(on));
  if (label) cta.textContent = label;
  for (const id of ['pwRestore', 'pwRedeem', 'pwClose']) $(id).disabled = on;
  for (const p of document.querySelectorAll('.pwPlan')) p.disabled = on;
}

function setMsg(text, kind){
  const m = $('pwMsg');
  m.textContent = text || '';
  m.className = 'pwMsg' + (kind ? ' ' + kind : '');
}

async function buy(){
  if (busy || !copy) return;
  setMsg('');
  setBusy(true, 'Confirming…');
  const r = await store.purchase(selected);
  if (!resolver) return;
  setBusy(false);
  if (r.status === 'success' && store.isPremium()) return succeed();
  renderPlans();
  setMsg(purchaseMessage(r.status), r.status === 'pending' ? 'info' : 'error');
}

async function doRestore(){
  if (busy) return;
  setMsg('');
  setBusy(true);
  $('pwRestore').textContent = 'Restoring…';
  const r = await store.restore();
  $('pwRestore').textContent = 'Restore Purchases';
  if (!resolver) return;
  setBusy(false);
  if (copy) renderPlans(); else renderError('');
  if (r.active) return succeed();
  const msg = restoreMessage(r);
  setMsg(msg, r.status === 'ok' ? 'info' : 'error');
}

function succeed(){
  setBusy(true, 'You’re in.');
  $('pwCta').classList.add('ok');
  setTimeout(() => { $('pwCta').classList.remove('ok'); closePaywall(true); }, 900);
}

export function wirePaywall(){
  $('pwClose').onclick = () => { if (!busy) closePaywall(false); };
  $('pwRestore').onclick = doRestore;
  $('pwRedeem').onclick = () => { if (!busy) store.redeemCode(); };
}
