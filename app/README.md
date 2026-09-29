# Dawn Alarm

A morning alarm you dismiss by doing push-ups, counted through the front
camera. Capacitor + Vite + vanilla JS.

The rep detection is **ported verbatim** from `../rep-counter.html`. See
[Porting rules](#porting-rules) before touching `src/counter.js`.

---

## What iOS will and won't allow

You already knew about Critical Alerts. These are the rest, and some of them
change what this app can be.

### How the alarm actually rings

The alarm is a **background audio session**, with notifications kept as a
fallback. An `AVAudioSession` in `.playback` keeps running when the app is
backgrounded and plays on the *media* channel, so it loops continuously and
rings with the silent switch on.

| | Clock.app alarm | This app |
|---|---|---|
| Ignores the silent switch | yes | **yes** (audio); no (notification fallback) |
| Ignores the volume setting | yes | **no — rings at media volume** |
| Rings until dismissed | yes | **yes**, unless force-quit |
| Breaks through Focus | yes | yes (`timeSensitive` + audio) |
| Opens an app automatically | n/a | **no — requires a tap** |
| Survives force-quit | yes | **no** (see below) |

#### Why not AlarmKit

Apple shipped AlarmKit in iOS 26 for exactly this use case, and it is the
obvious candidate. It cannot work here, for one reason.

From [Apple's `AlarmPresentation.Alert`
docs](https://developer.apple.com/documentation/alarmkit/alarmpresentation/alert-swift.struct):

> "Alert configures the title and buttons in the alarm UI. **The system
> provides a stop button automatically.** Use this object to optionally define
> a secondary button and its behavior."

And the initializer:

```swift
init(title: LocalizedStringResource,
     stopButton: AlarmButton,                                   // required
     secondaryButton: AlarmButton? = nil,                       // optional
     secondaryButtonBehavior: SecondaryButtonBehavior? = nil)
```

`stopButton` is non-optional with no default; only the *secondary* button is
optional. So every AlarmKit alarm ships a Stop button that ends the alarm
without the app being launched or consulted — `AlarmManager.stop(id:)` deletes
or reschedules it outright. The secondary button with `.custom` behaviour can
open the app, but it cannot be the *only* button, and it cannot make Stop
conditional.

The entire product is that you cannot dismiss the alarm without doing the reps.
A guaranteed one-tap Stop defeats it completely, so AlarmKit is unusable as the
enforcement mechanism no matter how good the rest of it is.

Two further costs, had it worked: it is **iOS 26+** (this project targets 15.0,
so adopting it would drop every device below iOS 26), and it needs
`NSAlarmKitUsageDescription`. A Capacitor plugin would *not* need writing from
scratch — [`@capawesome/capacitor-alarm`](https://www.npmjs.com/package/@capawesome/capacitor-alarm)
already wraps AlarmKit — but that does not change the verdict.

It is still worth revisiting if Apple ever allows a custom dismissal condition.

#### What kills the audio alarm

**Force-quitting from the app switcher.** iOS tears the process down and the
audio with it, and nothing can prevent that — no background mode, no
entitlement. The notification bursts remain scheduled as a fallback so a
force-quit still produces beeps, and the alarm screen says plainly that swiping
the app away disables the reliable alarm.

Handled, because each is otherwise a way to oversleep:

| Event | Behaviour |
|---|---|
| Incoming call / Siri | Interruption observed; the alarm resumes when it ends, whether or not the system flags `shouldResume` |
| Headphones unplugged | Route change observed; keeps ringing on the speaker instead of pausing, which is the default |
| Media services reset | Players rebuilt and the alarm restarted |
| Relaunch mid-alarm | The plugin records that it *was* ringing but never resumes on its own — JS re-enters through the same gate, so a completed morning stays silent |
| Podcast playing at arm time | Keepalive uses `.mixWithOthers`, so arming does not stop it. Only the alarm itself takes the session over |

#### Battery

Holding an audio session open from arm time to fire time is not free. The
process stays resident and the audio unit keeps running, even though the
keepalive loop is silent.

Estimate: **~0.5–1.5% per hour**, so **roughly 4–12% across an eight-hour
night**. That is reasoned from the cost of local audio playback with the screen
off (Apple rates recent iPhones at ~80 hours of audio playback, ≈1.25%/hour);
this is cheaper — no Bluetooth, no network, tiny file, volume 0 — but the
session is the thing that costs, not the content. **It has not been measured on
a device**; measure it before trusting the range.

Ways to reduce it, none of them silently chosen:

1. **Arm later.** The cost is arm-time to fire-time, so arming at 23:00 for
   06:30 costs 7.5 hours of it, not 24.
2. **Make it a toggle** — "reliable alarm" (audio, costs battery) vs
   "notifications only" (free, stops after ~7 minutes). This is the real lever
   and it is a product decision, so it is proposed rather than built.
3. Lowering the keepalive sample rate is *not* worth it — `AVAudioPlayer`
   resamples to the hardware rate anyway, so the saving is negligible.

#### App Store risk

Worth knowing before building further on this. **Guideline 2.5.4** says
multitasking apps may use background modes only for their intended purpose;
using the audio mode to keep an app alive rather than to play audible content
is a known rejection reason, and playing near-silence for eight hours is
squarely in that gray area.

What is in this app's favour: it genuinely is an alarm clock, the audio session
exists to play an alarm, and it does play real audio at fire time. Alarmy and
several other anti-snooze alarms ship exactly this pattern and are on the
store, which is evidence it passes — not a guarantee, since precedent is not
policy.

Realistic assessment: **moderate risk**. The common outcome is a reviewer
asking you to justify the background mode rather than an outright rejection.
There is no entitlement to apply for; it is a review judgement. Explain the
alarm use case in the App Review notes, and have the toggle above ready as a
fallback position if a reviewer pushes back.

**The Critical Alerts entitlement** (Apple grants it by application, mainly to
medical and safety apps) is the only thing that overrides the silent switch and
volume. An alarm app is unlikely to be approved.

### The ringer (superseded by the audio alarm, but still true of notifications)

`timeSensitive` beats Focus and Do Not Disturb. It does **not** beat the
physical silent switch or the volume slider, and neither does anything else
short of Critical Alerts.

I checked whether the app could at least *warn* you when the ringer is off.
It cannot, reliably:

| | |
|---|---|
| Silent switch | **No public iOS API.** Every plugin that claims it (`@capgo/capacitor-mute`, `@capawesome/capacitor-silent-mode`) plays a short silent sound and times it. capawesome's own docs: "may be inaccurate while other audio is playing or when the audio session category overrides the switch". capgo's: their underlying `Mute` library "is not configured as Apple expect anymore" since Xcode 14. |
| Ringer volume | **Not readable.** `AVAudioSession.outputVolume` is the *media* volume — a different slider from the one governing notification sounds. |
| Timing | **Foreground only.** capawesome's listener polls on a timer and pauses in the background. The alarm fires with the app closed, so a reading taken at arm time says nothing about the switch at 06:30. |

That last row is decisive: even a perfect detector answers the wrong question.
And a detector that is wrong in either direction is worse than none — "your
ringer is on" when it is off is precisely the silent failure it would exist to
prevent.

**The background audio alarm has since solved most of this**: `.playback` plays
regardless of the silent switch, so the audio alarm rings with the phone on
silent. The advisory is narrowed rather than removed, because two things remain
true — it rings at the *media volume*, and the notification fallback still
obeys the silent switch. It never blocks arming.

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

### Alarm sounds

Five, gentle to insistent: `dawn`, `chime` (default), `pulse`, `cascade`,
`reveille`. All synthesised by `scripts/make-sounds.py` and committed, so the
repo owns them outright — no samples, no licensing question if this ships paid.
`npm run sounds` regenerates them and re-adds them to the iOS target.

A notification sound **cannot be added at runtime** — it has to be in the
bundle at build time, which is why the set is fixed rather than downloadable.
It also has to be at the bundle root and a member of the App target, or iOS
silently substitutes the default; `scripts/add-ios-sounds.cjs` handles that
with a real pbxproj parser. See `ios-assets/sounds/README.md`.

The sharp edge: **the sound is baked into each scheduled notification**, and
there are 56 pending. Changing the choice rebuilds all of them via `arm()`,
which reads the satisfied morning first and skips it — so a sound change cannot
resurrect a morning already dismissed.

### What counts as dismissing the alarm

A morning is satisfied **only when a set is completed** — reps finished, the
30-second timer run down, or a deliberate bail. All three are real exits and
all three count.

What does **not** count: tapping the notification, swiping it away (iOS doesn't
report those anyway), opening the app and abandoning it, or a "Try it now" test
run.

The ring screen shows a **back arrow only for a test run**. When a real alarm
is ringing that screen is the dismissal gate, so a one-tap exit would reduce
the rep requirement to a tap; the arrow is not rendered at all. Backing out of
a test does not go through `onFinish`, so it cannot satisfy a morning or cancel
a scheduled notification. *I can't do this right now* remains the deliberate
exit from both. The satisfied morning is recorded durably (`dawn.satisfied`), so a
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

### 0. The continuous alarm — do these first

Everything below this section predates the audio alarm. These are the new ones,
and the highest priority, because none of it has ever run.

| Test | Expected |
|---|---|
| Arm, lock the phone, wait for the alarm | Rings **continuously**, not for 30s |
| Same, with the **silent switch on** | Still rings (this is the big one) |
| Let it ring 5+ minutes untouched | Still going |
| Do the reps | Stops immediately, and stays stopped |
| Ring, then call the phone from another one | Alarm resumes after the call ends |
| Ring with headphones in, then yank them out | Keeps ringing on the speaker |
| Ring, then force-quit from the app switcher | Audio dies (expected); notification beeps continue |
| Force-quit, then tap a notification | App opens and the alarm **resumes** |
| Do the reps, then force-quit and reopen | Does **not** start ringing again |
| Start a podcast, then arm | Podcast keeps playing |
| Arm overnight, check Settings → Battery | Compare against the 4–12% estimate |


Notification scheduling, delivery, sound and the satisfaction rules were
developed on Linux. The **logic** is covered by 48 assertions in
`scripts/verify-escapes.mjs`; **delivery** is covered by nothing. These are the
checks that need a real iPhone, in rough priority order.

### 1. A set dismisses the morning, and nothing else does

Set the alarm 2 minutes out, lock the phone, wait for it to ring.

| Test | Expected |
|---|---|
| Pick each sound, tap Preview | Each plays, and sounds distinct |
| Pick a sound, then let a real alarm ring | The notification uses **that** sound, not the default |
| Change the sound while armed, then ring | Still the newly chosen one (all 56 were rebuilt) |
| Do reps, then change the sound, then wait | That morning does **not** start ringing again |
| Real alarm rings, look at the ring screen | **No back arrow** in the top-left |
| *Try it now*, look at the ring screen | Back arrow present, clear of the notch |
| Back out of a test run, then check the alarm screen | Still armed, same ring-through date |
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
