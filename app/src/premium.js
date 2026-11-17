// Dawn Premium decisions - pure, no Capacitor imports, tested by
// scripts/verify-premium.mjs. The StoreKit bridge is src/store.js; the
// native side is ios/App/App/DawnStore.swift.

export const YEARLY = 'dawn.premium.yearly';
export const MONTHLY = 'dawn.premium.monthly';
export const LIFETIME = 'dawn.premium.lifetime';

export const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
export const PRIVACY_URL = 'https://dawn-alarm.vercel.app/privacy';

// Build numbers (CFBundleVersion) Dawn 1.0 shipped as. AppTransaction's
// originalAppVersion is the build number of the Apple ID's FIRST download.
// Exact string match: the sandbox, TestFlight and Xcode always report "1.0",
// which must never grandfather a test account.
export const LEGACY_BUILDS = ['1', '2'];
export function isLegacyBuild(originalAppVersion){
  return originalAppVersion != null && LEGACY_BUILDS.includes(String(originalAppVersion).trim());
}

// How long past its expiry a cached "active" subscription is still trusted
// with no fresh answer (offline, StoreKit slow). StoreKit's own
// currentEntitlements works offline, so this is a second line of defence.
export const OFFLINE_SLACK_DAYS = 3;
const DAY = 86400000;

export function cacheTrusted(cache, now){
  if (!cache || !cache.active) return false;
  if (cache.lifetime || cache.expires == null) return true;
  return now < cache.expires + OFFLINE_SLACK_DAYS * DAY;
}

// live: the entitlement StoreKit just reported this session, or null.
export function resolveAccess({ legacy, live, cache, now }){
  if (legacy) return { premium: true, source: 'legacy' };
  if (live) return { premium: !!live.active, source: 'live' };
  if (cacheTrusted(cache, now)) return { premium: true, source: 'cache' };
  return { premium: false, source: 'none' };
}

// ---------------------------------------------------------------------------
// Paywall copy. Every price is StoreKit's own localized displayPrice /
// pricePerMonth string - nothing here is a number in dollars.
// ---------------------------------------------------------------------------
export function periodText(p){
  if (!p) return '';
  const unit = String(p.unit || '').toLowerCase();
  if (unit === 'week' && p.value * 7 <= 14) return plural(p.value * 7, 'day');
  return plural(p.value, unit || 'day');
}
function plural(n, w){ return n + ' ' + w + (n === 1 ? '' : 's'); }

export function savingsPercent(yearly, monthly){
  if (!yearly || !monthly || !(yearly.price > 0) || !(monthly.price > 0)) return null;
  const pct = Math.round((1 - yearly.price / (monthly.price * 12)) * 100);
  return pct >= 10 ? pct : null;
}

export function planCopy(products){
  const by = Object.fromEntries((products || []).map(p => [p.id, p]));
  const y = by[YEARLY], m = by[MONTHLY], l = by[LIFETIME];
  const trial = y && y.trial && y.trialEligible ? periodText(y.trial) : null;
  const save = savingsPercent(y, m);
  const plans = [];
  if (y) plans.push({
    id: YEARLY, title: 'Yearly',
    badge: save ? 'Save ' + save + '%' : null,
    line: trial ? trial + ' free, then ' + y.displayPrice + '/year' : y.displayPrice + '/year',
    sub: y.pricePerMonth ? y.pricePerMonth + '/month' : null,
    cta: trial ? 'Start free trial' : 'Subscribe',
    fine: trial
      ? 'Free for ' + trial + ', then ' + y.displayPrice + ' per year. Your subscription renews automatically ' +
        'unless you cancel at least 24 hours before the end of the current period. Cancel anytime in Settings.'
      : y.displayPrice + ' per year. Renews automatically unless cancelled at least 24 hours before the end of ' +
        'the current period. Cancel anytime in Settings.'
  });
  if (m) plans.push({
    id: MONTHLY, title: 'Monthly', badge: null,
    line: m.displayPrice + '/month', sub: null, cta: 'Subscribe',
    fine: m.displayPrice + ' per month. Renews automatically unless cancelled at least 24 hours before the end ' +
      'of the current period. Cancel anytime in Settings.'
  });
  if (l) plans.push({
    id: LIFETIME, title: 'Lifetime', badge: null,
    line: l.displayPrice + ' once', sub: 'Yours forever', cta: 'Unlock forever',
    fine: 'One payment of ' + l.displayPrice + '. Not a subscription - nothing renews.'
  });
  return { plans, hasTrial: !!trial };
}

// What to tell someone after a purchase / restore attempt. '' = say nothing.
export function purchaseMessage(status){
  switch (status){
    case 'success': return '';
    case 'cancelled': return '';
    case 'pending': return 'Waiting for approval. Premium unlocks as soon as it’s approved.';
    case 'network': return 'Couldn’t reach the App Store. Check your connection and try again.';
    case 'notAllowed': return 'Purchases are turned off on this iPhone (Settings → Screen Time → Content & Privacy Restrictions).';
    case 'unavailable': return 'This option isn’t available in your country’s App Store right now.';
    case 'unverified': return 'The App Store couldn’t verify this purchase, so Premium wasn’t unlocked. Tap Restore Purchases to try again.';
    default: return 'Something went wrong. Please try again.';
  }
}

export function restoreMessage(r){
  if (r.status === 'cancelled') return '';
  if (r.status === 'network') return 'Couldn’t reach the App Store. Check your connection and try again.';
  if (r.active) return 'Purchases restored. Premium is active.';
  if (r.status === 'ok') return 'No Dawn Premium purchase was found for this Apple Account.';
  return 'Couldn’t restore purchases. Please try again.';
}
