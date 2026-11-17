# Dawn 1.1 — Premium (StoreKit 2), multiple alarms, streak & stats

No third-party SDKs. Purchases go straight to the App Store; the privacy label stays **Data Not Collected**.

| Piece | File |
|---|---|
| StoreKit 2 plugin (adapted from Mysterium) | `ios/App/App/DawnStore.swift` |
| JS bridge, offline cache, v1.0 detection | `src/store.js` |
| Prices/copy, access rules (pure, tested) | `src/premium.js` |
| Alarms, free/Premium rules, owed push-ups (pure, tested) | `src/alarms.js` |
| Streak & stats (pure, tested) | `src/history.js` |
| Paywall | `src/paywall.js`, `src/paywall.css`, `index.html` |
| Local StoreKit config | `ios/App/Dawn.storekit` (tests + "App (Local StoreKit)" scheme) |
| StoreKit tests | `ios/App/AppTests/StoreKitTests.swift` |
| JS tests | `npm run verify` (includes `verify:premium`) |

## Products (created in App Store Connect)

| Product | ID | Price | Notes |
|---|---|---|---|
| Dawn Premium Yearly | `dawn.premium.yearly` | $29.99/yr | 1-week free trial, level 1 |
| Dawn Premium Monthly | `dawn.premium.monthly` | $4.99/mo | level 2 |
| Dawn Lifetime | `dawn.premium.lifetime` | $59.99 base (never sold) | non-consumable; **not on the paywall** — creators only, via free offer codes |

Group: **Dawn Premium**. The paywall sells only Yearly and Monthly. Either an active subscription or a redeemed Lifetime code unlocks Premium.

## Free vs Premium

- **Free:** one alarm, every day, 10 reps, Chime; "Try it now" always.
- **Premium:** more alarms, custom reps, every sound, repeat schedules (specific days / one-time), streak & stats.
- **Premium ends (expiry, refund, billing failure without grace):** every alarm keeps ringing exactly as set. Editing them or adding new ones is locked. Turning one off or deleting it is always free.
- **v1.0 users:** Premium free for life (see below).

### How v1.0 users are detected

Either signal grandfathers, and once true it is stored:

1. **App Store record:** `AppTransaction.shared` is verified on device, then `originalAppVersion` is checked. That's the build number of this Apple Account's first download. Dawn 1.0 shipped as build `2` (`1` also accepted). Survives deleting and reinstalling. Sandbox/TestFlight always report `1.0`, which deliberately does not match.
2. **On the phone:** on the first 1.1 launch, a saved 1.0 alarm (`dawn.alarm`) already exists.

## Creator lifetime access (free for life for creators who promote Dawn)

Dawn Lifetime is not sold anywhere in the app. It exists only so a creator can redeem a free code.


App Store Connect → Dawn → In-App Purchases → Dawn Lifetime → **Offer Codes → Create Offer** → price **Free** → generate one-time codes (or a custom code). Creators redeem in Dawn (Settings or paywall → **Redeem code**), via the App Store, or via the redeem link. The app picks it up through `Transaction.updates`.

## Sandbox test on your iPhone

Set up: App Store Connect → Users and Access → Sandbox → create 2–3 test accounts. On the phone: Settings → Developer → Sandbox Apple Account → sign in. Run the **App** scheme (not "Local StoreKit"). Sandbox time is compressed: the 1-week trial lasts ~3 minutes, a month ~5 minutes.

- [ ] **Free user:** fresh install → add one alarm (10 reps, Chime, every day) → it rings → push-ups dismiss it.
- [ ] Free: "+ New alarm" a second time, reps +/−, another sound, a day chip, "Streak & stats" → each opens the paywall.
- [ ] Paywall: Yearly pre-selected, "7 days free, then $29.99/year", Save 50%, Monthly $4.99, and **no Lifetime option**. Restore, Redeem code, Terms of Use and Privacy links work.
- [ ] After the first real morning dismissal, the paywall appears once (dismissible). Never during a ring.
- [ ] **Trial:** Start free trial → Apple sheet shows 1 week free → Premium unlocks. Settings shows "Free trial, ends …".
- [ ] Trial used: delete the app, reinstall, same account → yearly shows no trial, button "Subscribe".
- [ ] **Monthly:** second sandbox account → Monthly → Premium.
- [ ] **Creator code:** create a free Dawn Lifetime offer code → third sandbox account → Redeem code → Settings shows "Lifetime", no Manage subscription.
- [ ] **Restore:** delete, reinstall → Restore Purchases → Premium returns.
- [ ] Expiry: cancel the sandbox subscription and let it lapse → alarms keep ringing; edits locked; turn off/delete still work.
- [ ] Offline: airplane mode → relaunch → Premium still on (cached).
- [ ] **Overnight:** two Premium alarms (e.g. 06:30 and 06:40) → both ring; each Stop → push-ups; finishing one does not cancel the other.

## App Review notes (paste into the 1.1 version's Notes)

> Dawn 1.1 adds Dawn Premium: auto-renewable subscriptions in the group "Dawn Premium" (Yearly $29.99 with a 1-week free trial for new subscribers; Monthly $4.99). The non-consumable "Dawn Lifetime" is not sold in the app; it is only granted to promotional partners through free offer codes, redeemed via "Redeem code".
>
> Free without purchase: one daily alarm with the default 10 push-ups and default sound, plus "Try it now", which runs the full experience on demand (alarm sound and on-device camera push-up counting that turns it off).
>
> Premium unlocks more alarms, custom rep counts, all alarm sounds, repeat schedules (specific days or one-time), and a streak & stats screen.
>
> To reach the paywall: on the home screen, tap "+ New alarm" after creating the first one, or tap "Streak & stats", or open Settings (gear, top right) → See plans. It also appears once after the first real alarm is dismissed. Restore Purchases and Redeem code are on the paywall and in Settings; Terms of Use (Apple standard EULA) and the Privacy Policy are linked from both. All prices come from StoreKit.
>
> Everyone who installed version 1.0 (previously free) keeps every feature free for life. No account or sign-in. The camera is used only on device to count push-ups; nothing is recorded or sent. The app collects no data.

## Release checklist

1. `npm run verify` and the Xcode StoreKit tests pass.
2. Sandbox checklist above, plus the overnight two-alarm test.
3. Archive 1.1 (3) → upload.
4. On the 1.1 version page → In-App Purchases and Subscriptions → add all three products (Lifetime too, so offer codes work). Add a review screenshot of the paywall to each product.
5. Review notes above. App Privacy: unchanged (Data Not Collected).
6. Record the review video, then submit (only when you say go).
