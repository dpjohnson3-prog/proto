// StoreKit 2 bridge for Dawn Premium (native: ios/App/App/DawnStore.swift).
// No third-party SDK: purchases go straight to the App Store and nothing is
// sent anywhere else.
//
// Rules: nothing in the alarm boot path waits on this; access() is
// synchronous, from the best answer available (v1.0 grandfathering, this
// session's StoreKit answer, or the cached last answer).
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { resolveAccess, isLegacyBuild, LIFETIME, YEARLY, MONTHLY } from './premium.js';

const isNative = Capacitor.isNativePlatform();
const Native = registerPlugin('DawnStore');

const state = { legacy: false, live: null, cache: null, everPremium: false };
const listeners = new Set();
export function onChange(fn){ listeners.add(fn); return () => listeners.delete(fn); }
function emit(){ for (const fn of listeners){ try { fn(); } catch (e){} } }

export const access = () => resolveAccess({ legacy: state.legacy, live: state.live, cache: state.cache, now: Date.now() });
export const isPremium = () => access().premium;
export const isLegacy = () => state.legacy;
export const live = () => state.live;
// True once someone has had Premium on this device - drives the "your
// Premium has ended" note.
export const everPremium = () => state.everPremium;

async function getJSON(key){
  try { const { value } = await Preferences.get({ key }); return value ? JSON.parse(value) : null; }
  catch (e){ return null; }
}
async function setJSON(key, v){
  try { await Preferences.set({ key, value: JSON.stringify(v) }); } catch (e){}
}

function withTimeout(p, ms){
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// ---------------------------------------------------------------------------
// v1.0 users: Premium for life. Two independent signals, either is enough:
//  1. Local: on the FIRST v1.1 launch, a saved v1.0 alarm ('dawn.alarm')
//     already exists. Decided once, before anything else writes, and stored.
//  2. App Store: AppTransaction.originalAppVersion - the build number of this
//     Apple Account's first download - is "1" or "2" (Dawn 1.0's builds).
//     Signed by Apple and verified on device; survives deleting and
//     reinstalling the app. The sandbox always reports "1.0", which does not
//     match, so test accounts are never grandfathered by accident.
// ---------------------------------------------------------------------------
async function detectLegacyLocal(){
  const rec = await getJSON('dawn.install');
  if (rec && typeof rec.legacy === 'boolean') return rec.legacy;
  let legacy = false;
  try { legacy = !!(await Preferences.get({ key: 'dawn.alarm' })).value; } catch (e){}
  await setJSON('dawn.install', { legacy, via: legacy ? 'local' : null, decidedAt: Date.now() });
  return legacy;
}

async function checkAppTransaction(){
  if (!isNative || state.legacy) return;
  try {
    const t = await withTimeout(Native.appTransaction(), 8000);
    if (t && t.verified && isLegacyBuild(t.originalAppVersion)){
      state.legacy = true;
      await setJSON('dawn.install', { legacy: true, via: 'appTransaction:' + t.originalAppVersion, decidedAt: Date.now() });
      emit();
    }
  } catch (e){}
}

// ---------------------------------------------------------------------------
export async function init(){
  state.legacy = await detectLegacyLocal();
  state.cache = await getJSON('dawn.premiumCache');
  state.everPremium = !!(await getJSON('dawn.everPremium'));
  if (isNative){
    try { await Native.addListener('entitlementChanged', (e) => { apply(e); }); } catch (e){}
  }
}

async function apply(e){
  if (!e || typeof e.active !== 'boolean') return;
  state.live = e;
  state.cache = { active: e.active, lifetime: !!e.lifetime, expires: e.expires ?? null,
                  productId: e.productId ?? null, inTrial: !!e.inTrial, willRenew: !!e.willRenew,
                  checkedAt: Date.now() };
  await setJSON('dawn.premiumCache', state.cache);
  if (e.active && !state.everPremium){ state.everPremium = true; await setJSON('dawn.everPremium', true); }
  emit();
}

// Re-check: launch (after the alarm is routed) and every foreground return.
export async function refresh(){
  if (!isNative){ await apply(mock.entitlement()); return true; }
  checkAppTransaction();
  try { await apply(await withTimeout(Native.entitlement(), 10000)); return true; }
  catch (e){ return false; }
}

export async function loadProducts(){
  if (!isNative) return { ok: true, products: mock.products() };
  try {
    const r = await withTimeout(Native.products(), 15000);
    const products = (r && r.products) || [];
    if (!products.length) return { ok: false, message: 'Plans aren’t available right now. Please try again later.' };
    return { ok: true, products };
  } catch (e){
    return { ok: false, message: 'Couldn’t reach the App Store. Check your connection and try again.' };
  }
}

export async function purchase(id){
  if (!isNative) return mock.purchase(id);
  try {
    const r = await Native.purchase({ id });
    if (r && typeof r.active === 'boolean' && r.status === 'success') await apply(r);
    return r || { status: 'error' };
  } catch (e){ return { status: 'error' }; }
}

export async function restore(){
  if (!isNative) return mock.restore();
  try {
    const r = await Native.restore();
    await apply(r);
    return { ...r, active: access().premium };
  } catch (e){ return { status: 'error', active: access().premium }; }
}

export async function manage(){
  if (!isNative) return;
  try { await Native.manage(); } catch (e){}
}

export async function redeemCode(){
  if (!isNative) return;
  try { await Native.redeemCode(); } catch (e){}
}

export function statusLine(){
  const acc = access(), e = state.live || state.cache;
  if (state.legacy) return 'Lifetime - thanks for being here since 1.0';
  if (!acc.premium) return 'Not active';
  if (!e) return 'Active';
  if (e.lifetime || e.productId === LIFETIME) return 'Lifetime';
  const date = e.expires ? new Date(e.expires).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  if (e.inTrial) return 'Free trial' + (date ? ', ends ' + date : '');
  if (e.inGracePeriod) return 'Active - update your payment details in Settings';
  const plan = e.productId === YEARLY ? 'Yearly' : e.productId === MONTHLY ? 'Monthly' : 'Premium';
  return plan + (date ? (e.willRenew ? ', renews ' : ', ends ') + date : '');
}

// ---------------------------------------------------------------------------
// Browser stand-in for `vite dev` - fake products, purchases flip a flag.
// ---------------------------------------------------------------------------
const mock = {
  get(){ try { return localStorage.getItem('dawn.devPremium'); } catch (e){ return null; } },
  set(v){ try { localStorage.setItem('dawn.devPremium', v); } catch (e){} },
  entitlement(){
    const v = this.get();
    return { active: !!v, lifetime: v === LIFETIME, productId: v || undefined, inTrial: v === YEARLY, willRenew: !!v,
             expires: v && v !== LIFETIME ? Date.now() + 7 * 86400000 : undefined };
  },
  products(){
    return [
      { id: YEARLY, displayPrice: '$29.99', price: 29.99, type: 'subscription', pricePerMonth: '$2.50',
        period: { unit: 'year', value: 1 }, trial: { unit: 'week', value: 1 }, trialEligible: !this.get() },
      { id: MONTHLY, displayPrice: '$4.99', price: 4.99, type: 'subscription', period: { unit: 'month', value: 1 } },
      { id: LIFETIME, displayPrice: '$59.99', price: 59.99, type: 'lifetime' }
    ];
  },
  async purchase(id){
    await new Promise(r => setTimeout(r, 600));
    this.set(id); await apply(this.entitlement());
    return { status: 'success', ...this.entitlement() };
  },
  async restore(){ await apply(this.entitlement()); return { status: 'ok', active: access().premium }; }
};
