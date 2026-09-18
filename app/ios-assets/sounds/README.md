# Alarm sounds

**These are generated, not sourced.** `scripts/make-sounds.py` synthesises all
five from sine partials — no samples, no clips, no licensing question if this
ever ships paid. Regenerate any time:

```sh
npm run sounds     # make-sounds.py, then add-ios-sounds.cjs
```

## Where they live, and why twice

iOS treats the two uses as completely unrelated:

| Path | Used by | Committed |
|---|---|---|
| `public/sounds/<id>.wav` | the ring screen's in-app audio | yes |
| `ios/App/App/<id>.wav` | the notification sound | yes |

Both are committed on purpose. If the iOS copies were generated-on-demand, a
fresh clone would build an app whose notifications fall back to the default
sound — silently, which is the failure mode this app keeps trying not to have.

## Apple's rules these files satisfy

| Rule | Here |
|---|---|
| Under 30 seconds | 20.0s |
| Linear PCM / MA4 / µ-law / a-law, as `.caf` / `.wav` / `.aiff` | 16-bit linear PCM `.wav`, 22.05 kHz mono |
| At the bundle root, not a subdirectory | `ios/App/App/*.wav`, added to the App target |
| Named per-notification at schedule time | `soundFile(id)` in `src/alarm.js` |

That last rule is the sharp edge: the sound is baked into each scheduled
notification, and there are 56 pending. Changing the selected sound rebuilds
all of them — `arm()` does this, and skips any morning already satisfied so a
rebuild cannot resurrect a dismissed alarm.

## Target membership

A `.wav` sitting in `ios/App/App/` is **not** in the bundle unless it is a
member of the App target. `scripts/add-ios-sounds.cjs` does that, using the
`xcode` pbxproj parser rather than hand-patching. It is idempotent and its
diff is purely additive. Re-run it after adding a sound.

## The set

| id | character |
|---|---|
| `dawn` | slow swell on a fifth, barely there |
| `chime` | three struck bell tones, decaying — the default |
| `pulse` | even, unhurried pulses |
| `cascade` | descending four-note figure |
| `reveille` | repeated triplet, quick and bright |

To re-voice them, edit the functions in `scripts/make-sounds.py` and re-run.
