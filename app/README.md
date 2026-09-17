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

So `src/alarm.js` schedules **4 notifications a minute apart** per morning
(`RING_BURST`, `BURST_GAP_MIN`) to get roughly 4 minutes of intermittent
ringing. It's the standard workaround, and it's still not a real alarm: it's
four notification sounds, not a siren. Tune the constants to taste.

Finishing your reps cancels that morning's remaining notifications
(`silenceThisMorning`), so it doesn't keep ringing while you make coffee.

### The 64-notification cap, and why the alarm expires

iOS keeps only the **64 soonest** pending local notifications per app. A
repeating daily notification would fit in one slot — but a single day's
occurrence can't be cancelled from a repeat, so finishing your reps couldn't
silence the rest of that morning's burst.

So this schedules explicit one-shot dates instead: `RING_BURST` (4) ×
`DAYS_AHEAD` (10) = **40 pending notifications**, topped up every time the app
is opened.

> **The consequence, stated plainly: if you don't open the app for 10 days, the
> alarm stops working.** Raising `DAYS_AHEAD` above 16 would exceed the 64 cap.
> The real fixes are a push server or a background-refresh task, both of which
> are more machinery than this prototype has.

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
