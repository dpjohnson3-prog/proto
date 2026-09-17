# Dawn Alarm

A morning alarm you dismiss by doing push-ups, counted through the front
camera. Capacitor + Vite + vanilla JS.

The rep detection is **ported verbatim** from `../rep-counter.html`. See
[Porting rules](#porting-rules) before touching `src/counter.js`.

---

## What iOS will and won't allow

You already knew about Critical Alerts. These are the rest, and some of them
change what this app can be.

### This is not a system alarm, and cannot be made into one

The Clock app's alarms use private API. A third-party app gets
`UNUserNotificationCenter`, which means:

| | Clock.app alarm | This app |
|---|---|---|
| Ignores the silent switch | yes | **no** |
| Ignores the volume setting | yes | **no** |
| Rings until dismissed | yes | **no — 30s max per notification** |
| Breaks through Focus | yes | partly (see below) |
| Opens an app automatically | n/a | **no — requires a tap** |

**The Critical Alerts entitlement** (Apple grants it by application, mainly to
medical and safety apps) is the only thing that overrides the silent switch and
volume. An alarm app is unlikely to be approved.

**What I did use:** `interruptionLevel: 'timeSensitive'`. It breaks through most
Focus modes, and unlike Critical Alerts it's a self-serve Xcode capability with
no approval process. **You must enable it:** Xcode → Signing & Capabilities →
+ Capability → *Time Sensitive Notifications*. The user can still turn it off
per-app in iOS Settings.

### The 30-second sound cap, and why the alarm rings in bursts

iOS ignores any notification sound longer than 30 seconds and substitutes the
default. There is no way to make one notification ring continuously.

So `src/alarm.js` schedules **8 notifications a minute apart** per morning
(`RING_BURST`, `BURST_GAP_MIN`): 8 sounds across 7 minutes. It's the standard
workaround, and it's still not a real alarm — it's eight notification sounds,
not a siren. `BURST_GAP_MIN` spreads the same 8 slots wider if you prefer
(gap 2 gives 14 minutes, sparser).

### The 64-notification cap, and the budget

iOS keeps only the **64 soonest** pending local notifications per app. A
repeating daily notification would fit in one slot — but a single day's
occurrence can't be cancelled from a repeat, so finishing your reps couldn't
silence the rest of that morning's burst.

So this schedules explicit one-shot dates, and bursts-per-morning (B) trades
directly against days-ahead (D):

| B | D | B×D | +warn | ring coverage | disuse buffer |
|---|---|---|---|---|---|
| 4 | 10 | 40 | 41 | 3 min | 10 days |
| 6 | 9 | 54 | 55 | 5 min | 9 days |
| **8** | **7** | **56** | **57** | **7 min** | **7 days** |
| 10 | 6 | 60 | 61 | 9 min | 6 days |
| 12 | 5 | 60 | 61 | 11 min | 5 days |

**Chosen: B=8, D=7, +1 warning = 57 pending, 7 slots spare.**

The reasoning: you cannot dismiss this alarm without opening the app, so every
normal morning re-arms a full window. D only buffers *disuse* — a trip, a
holiday — not routine use. Under-ringing costs you **every** morning; a lapsed
window costs you once, after D days of not touching the app, and is no longer
silent. Slots are better spent on B.

### The window still expires — but loudly

Two changes make "armed" stop being a lie:

1. **The alarm screen always shows the date it rings through**, how many
   mornings are left, and that it stops until you open the app again.
2. **A warning notification** fires at 20:00, `WARN_LEAD_DAYS` (2) before the
   last armed morning: *"It stops ringing after <date>. Open the app to keep it
   armed."* That costs exactly one slot and leaves two more mornings of slack.

> **Still true: if you ignore the warning and don't open the app, it lapses.**
> A genuinely reliable top-up needs one of:
>
> - **Background refresh** (`BGTaskScheduler`) — iOS decides if and when it
>   runs, based on how much you use the app. Reduces the lapse risk; does not
>   remove it. Cost: a native task handler plus a background-modes entitlement.
> - **A push server** — reliable, because the server re-arms you. Cost: a
>   backend, APNs certificates, device-token registration, and now the app has
>   infrastructure and a privacy surface it didn't have before.
>
> Neither is built. Ask before committing to either.

### What counts as dismissing the alarm

A morning is satisfied **only when a set is completed** — reps finished, the
30-second timer run down, or a deliberate bail. All three are real exits and
all three count.

What does **not** count: tapping the notification, swiping it away (iOS doesn't
report those anyway), opening the app and abandoning it, or a "Try it now" test
run. The satisfied morning is recorded durably (`dawn.satisfied`), so a
notification tapped out of Notification Center hours later cannot re-ring a
morning whose reps are done, and rebuilding the schedule cannot resurrect it.

### Other things that bite

- **Tapping the notification is mandatory.** An app cannot launch itself, so it
  cannot start the camera and count you while the phone sits on the nightstand.
- **In-app audio needs a user gesture.** If the alarm fires while the app is
  already open, `audio.play()` may be blocked by autoplay policy. Arming primes
  the element to unlock playback for the session, and the "Start push-ups" tap
  is the fallback gesture. The ring screen says so rather than failing silently.
- **Screen Wake Lock needs iOS 16.4+**, and the project's deployment target is
  15.0. On 15.x the screen may dim mid-set. If that bites, swap
  `requestWakeLock`/`releaseWakeLock` in `src/main.js` for
  `@capacitor-community/keep-awake`.
- **The Simulator has no camera.** `getUserMedia` fails there, by design. Use
  *Run without the camera* to exercise the counter on a simulated signal.

---

## Running it

### Web (works anywhere, including this repo's CI)

```sh
npm install
npm run dev       # http://localhost:5173  — add ?debug=1 for the overlay
```

Arming does nothing real in a browser; the app says so. *Try it now* walks the
whole ringing → calibration → counting → dismissed flow.

### iOS — requires macOS

**This was built and verified on Linux, so the Xcode half is unrun.** The
Simulator is macOS-only software; there is no way to run it from here. Every
step below is standard, but treat it as untested rather than as a promise.

```sh
npm install
npm run ios          # build + cap sync ios + open Xcode
```

Then, in Xcode:

1. Select the **App** target → Signing & Capabilities → set your Team.
2. Add the **Time Sensitive Notifications** capability (see above).
3. Drop your alarm sound in — see `ios-assets/sounds/README.md`. **No audio
   file ships with this repo on purpose.**
4. Pick a simulator → Run.

Capacitor 8 uses Swift Package Manager, so there is **no `pod install`**.

### Testing in the Simulator

| Works | How |
|---|---|
| Arm / disarm, persistence | Alarm screen |
| Notification permission prompt | Tap *Arm the alarm* |
| Scheduled delivery | Set the alarm a minute or two ahead |
| Tap-to-open → ringing → counting | Tap the banner |
| Counting logic | *Run without the camera* |
| All escape hatches | *It's not counting me* |
| Debug overlay | Five taps on the alarm screen heading |

### Needs a physical device

| Why |
|---|
| **Camera and real rep counting** — the Simulator has no camera at all |
| **Alarm sound** — custom notification sounds, ringer vs. silent switch, volume |
| **Ringing with the phone locked / app killed** — the actual use case |
| **Focus / Do Not Disturb** behaviour with `timeSensitive` |
| **Screen Wake Lock** during a set (and whether iOS 15 needs the plugin) |
| **Battery and thermals** — a camera + `requestAnimationFrame` loop at 6am |
| **Re-validating accuracy** — the detection maths is verified, the optics are not |
| **Notification scheduling and delivery** — none of it can run off-device |

That last one matters most. The counting logic is proven; what is *not* proven
is that a phone propped against a water glass at 6am sees the same luminance
signal the prototype was tuned against. Run a set with the debug overlay up and
watch `range` settle below `cal`.

---

## Porting rules

`src/counter.js` is **generated**, not hand-written:

```sh
npm run port     # regenerate counter.js + styles.css from ../rep-counter.html
npm run verify   # counting + escape hatches + safe-area insets
```

`src/styles.css` is generated too. The iOS safe-area insets live in
`scripts/port.py` as four documented CSS edits, **not** as hand edits to
`styles.css` — editing that file directly works until the next `npm run port`
silently reverts it. Each edit keeps the prototype's declaration and adds an
`env(safe-area-inset-*)` override after it, so the original value is untouched
and remains the fallback. `#dawn`/`#dawnWarm` are deliberately left full-bleed.

`scripts/port.py` applies exactly 9 documented edits to the prototype's script
and asserts each one matches exactly once — so it fails loudly rather than
silently mis-porting. Every one is plumbing or copy. **Nothing in the signal
path is touched:** all 20 tunables and all 14 signal-path functions are
byte-identical to the prototype, which the header of `counter.js` lists.

Do not retune `LOW`/`HIGH`, `ENV_TAU_OPEN`/`ENV_TAU_CLOSE`, `CAL_PCT`,
`ENV_FLOOR_FRAC`, `MIN_REP_MS`, `MIN_DOWN_MS`, `REP_SWING_FRAC` or `STEP_FRAC`.
They look arbitrary because they encode measured reality.

## Layout

```
src/counter.js   GENERATED — ported detection logic, do not hand-edit
src/alarm.js     notification scheduling, permissions, the iOS workarounds
src/storage.js   persisted settings (@capacitor/preferences)
src/main.js      app shell: screens, alarm wiring, audio, wake lock
scripts/port.py  regenerates counter.js AND styles.css from the prototype
ios-assets/      where the alarm sound goes (TODO)
```

---

## Device test plan (none of this can be verified off-device)

Notification scheduling, delivery, sound and the satisfaction rules were
developed on Linux. The **logic** is covered by 48 assertions in
`scripts/verify-escapes.mjs`; **delivery** is covered by nothing. These are the
checks that need a real iPhone, in rough priority order.

### 1. A set dismisses the morning, and nothing else does

Set the alarm 2 minutes out, lock the phone, wait for it to ring.

| Test | Expected |
|---|---|
| Tap the notification, then background the app without doing reps | It keeps ringing — bursts continue |
| Swipe the notification away | It keeps ringing |
| Open the app, sit on the ring screen, do nothing | It keeps ringing |
| Complete the reps | Ringing stops immediately, no further bursts |
| Finish via the 30-second timer instead | Ringing stops |
| Finish via *Just turn the alarm off* | Ringing stops |
| After finishing, pull down Notification Center and tap an older burst | Opens to the alarm screen, does **not** ring again |

### 2. A later burst must not interrupt a set in progress

Start the reps and keep going past the next burst (they are a minute apart).
The burst must not throw you back to the ring screen or restart the audio.
This is the one most likely to be wrong, because it depends on iOS delivering
`localNotificationReceived` to a foregrounded app.

### 3. A test run must not eat a real alarm

With the alarm armed for tomorrow, hit *Try it now* and complete the reps.
Then check the alarm screen still says armed, and confirm it rings tomorrow.
Sharper version: arm for 06:30, at 06:15 run a test and complete it — the
06:30 alarm must still ring.

### 4. The budget is real

After arming, confirm iOS actually holds all 57. There is no UI for this;
temporarily log `alarm.pendingCount()` (it should read 57) and watch it fall as
mornings pass. If it reads 64, something else is scheduling too and the oldest
are being dropped.

### 5. The lapse warning

Hard to wait 5 days for. To force it, temporarily set `WARN_LEAD_DAYS` to a
value close to `DAYS_AHEAD` so the warning schedules within minutes, and check
that tapping it opens the alarm screen and **does not start a ring**.

### 6. The things iOS decides, not you

- Ring with the phone locked, in Focus/Do Not Disturb, and with the silent
  switch on. The silent switch **will** kill it — confirm how dead it is.
- Custom sound actually plays (and is under 30s, or iOS substitutes the
  default silently).
- Screen stays awake through a whole set.
