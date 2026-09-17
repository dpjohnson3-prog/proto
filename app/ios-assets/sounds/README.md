# Alarm sound — NOT INCLUDED

**TODO: drop your alarm audio file here and in the two places listed below.**

No audio ships with this repo on purpose. A placeholder alarm sound is worse
than none: it gets shipped by accident, and you find out at 6am.

You need the *same* sound in two places, because iOS treats them separately.

## 1. Notification sound (the one that rings when the app is closed)

- Put the file at `ios/App/App/alarm.wav`.
- Add it to the **App** target in Xcode (drag into the project, tick
  "Copy items if needed" and the App target) or it will not be in the bundle.
- Keep the filename in sync with `ALARM_SOUND` in `src/alarm.js`.

Apple's constraints on notification sounds:

| Constraint | Value |
|---|---|
| Formats | Linear PCM, MA4, µ-law, a-law — packaged as `.caf`, `.wav` or `.aiff` |
| **Max length** | **30 seconds.** Longer files are ignored and you get the *default* sound |
| Location | Bundle root (or `Library/Sounds/`), not a subfolder |

Convert with:

```sh
afconvert -f WAVE -d LEI16@44100 -c 1 source.mp3 alarm.wav
```

## 2. In-app sound (when the app is already open)

- Put the same file at `app/public/sounds/alarm.wav`.
- Vite copies `public/` into the build, so it lands at `/sounds/alarm.wav`,
  which is what `ALARM_SRC` in `src/main.js` loads.
- The 30-second cap does **not** apply here — this one loops until the set is
  finished, so a short loopable clip works best.

Until both files exist: the notification falls back to the iOS default sound,
and the ring screen shows a visible warning instead of failing silently.
