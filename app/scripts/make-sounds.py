#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generates the alarm sounds, so the repo owns them outright.

Nothing is sourced or sampled: every tone is synthesised from sine partials
here. That keeps the repo self-contained, leaves no licensing question if this
ever ships paid, and means the set can be re-tuned and regenerated at will.

    python3 scripts/make-sounds.py
    python3 scripts/analyse-sounds.py     # measure what came out

Writes 16-bit mono linear-PCM WAV to BOTH places iOS needs them:

  public/sounds/<name>.wav   - bundled as a web asset, used by the ring screen
  ios/App/App/<name>.wav     - bundle root, used as the notification sound

Apple's rules these files have to satisfy:
  * under 30 seconds, or iOS silently substitutes the default sound
  * linear PCM / MA4 / u-law / a-law, in .caf, .wav or .aiff
  * at the bundle root (or Library/Sounds), never in a subdirectory

-----------------------------------------------------------------------------
WHY THE FIRST VERSION WAS INAUDIBLE, AND WHAT CHANGED
-----------------------------------------------------------------------------
Measured with analyse-sounds.py, the original set put 0.0%-2.1% of its energy
in the 2-4 kHz band and up to 96% below 500 Hz. A phone speaker is a tiny
sealed driver: it barely reproduces anything under ~500 Hz, and it is most
efficient across 2-5 kHz - which is also where human hearing is most sensitive.
So most of the signal was being spent on frequencies that never made it into
the room. `dawn` had the HIGHEST RMS of the five and was the QUIETEST in
practice, losing ~20 dB to the speaker.

Three changes, in order of how much they matter:

  1. PUT THE ENERGY WHERE THE SPEAKER LIVES. Every partial is weighted by
     voice_gain(), which emphasises 2-4 kHz and all but discards sub-300 Hz,
     and the voices now carry enough harmonics to have real content up there.
  2. STOP PAYING FOR BASS. A 300 Hz high-pass removes what the speaker cannot
     use, so peak headroom is not spent on inaudible rumble.
  3. RAISE THE AVERAGE. Compression then soft limiting lift the average level
     toward the peak, instead of a few transients holding the whole file down.

Then peaks are normalised to TARGET_PEAK_DB (-0.3 dBFS) with no clipping.

Each sound still starts gentler and reaches full level partway through, so a
single 20s play escalates rather than opening at maximum.

Loudness can only really be judged by ear on the device. These numbers make it
hard to ship something quiet by accident; they do not prove it sounds good.
"""
import array, math, os, wave

SR       = 22050        # plenty for tones; halves the file size vs 44.1k
DURATION = 20.0         # comfortably inside Apple's 30s ceiling
KEEPALIVE_SECONDS = 10.0  # long loop = fewer restarts while it runs all night

TARGET_PEAK_DB  = -0.3  # normalise here: loud, with a hair of headroom
HP_HZ           = 300.0 # below this a phone speaker gives almost nothing back
ESCALATE_FROM   = 0.40  # opening level (linear) ...
ESCALATE_BY     = 12.0  # ... reaching full by this many seconds
COMP_THRESH_DB  = -20.0
COMP_RATIO      = 4.0
LIMIT_DRIVE     = 1.6
CREST_K         = 1.6   # see voice(): trades worst-case headroom for level

HERE = os.path.dirname(os.path.abspath(__file__))
APP  = os.path.dirname(HERE)


# --- partial weighting -----------------------------------------------------

def voice_gain(f):
    """
    How much a partial at `f` is worth on a phone speaker.

    Mirrors the speaker's efficiency rather than fighting it: near-zero weight
    under 300 Hz, full weight across 2-4.5 kHz, easing off again past 7 kHz so
    nothing turns shrill.
    """
    if f < 200:    return 0.05
    if f < 300:    return 0.12
    if f < 800:    return 0.38
    if f < 1500:   return 0.62
    if f < 2000:   return 0.85
    if f < 4500:   return 1.00
    if f < 7000:   return 0.70
    return 0.30


def env(t, dur, attack, release):
    """Attack/release envelope. Never zero-length: an instant edge clicks."""
    a = max(attack, 0.005)
    r = max(release, 0.005)
    if t < a:       return t / a
    if t > dur - r: return max(0.0, (dur - t) / r)
    return 1.0


def voice(buf, start, dur, freq, ratios, attack, release, gain=1.0, decay=0.0):
    """
    One note: a set of partials at freq*ratio, each rolled off by 1/n and then
    weighted by voice_gain so the audible ones dominate.
    """
    i0 = int(start * SR)
    n  = int(dur * SR)
    parts = []
    for idx, ratio in enumerate(ratios):
        f = freq * ratio
        if f >= SR / 2:            # never synthesise above Nyquist: it aliases
            continue
        amp = voice_gain(f) / ((idx + 1) ** 0.7)
        parts.append((f, amp))
    # Normalising by sum(amplitudes) is worst-case-peak safe - it assumes every
    # partial aligns at once - but that alignment is rare, so it throws away
    # 3-6 dB of level to guard against a moment that mostly does not happen.
    # Normalise by the RMS of the partials instead and let soft_limit() catch
    # the rare alignment. Measured: +3 dB at CREST_K 1.4, +5 dB at 2.0.
    norm = (math.sqrt(sum(a * a for _, a in parts)) or 1.0) / CREST_K
    for i in range(n):
        j = i0 + i
        if j >= len(buf): break
        t = i / SR
        e = env(t, dur, attack, release)
        if decay: e *= math.exp(-decay * t)
        s = 0.0
        for f, a in parts:
            s += a * math.sin(2 * math.pi * f * t)
        buf[j] += (s / norm) * e * gain


def blank():
    return [0.0] * int(DURATION * SR)


# --- the five voices, gentle -> insistent ----------------------------------
# Fundamentals are chosen so their harmonics land in 2-4 kHz, which is the
# whole point: a 440 Hz tone with eight harmonics has real content at 2.2, 2.6,
# 3.1 and 3.5 kHz, where the speaker can actually deliver it.

HARMONIC  = [1, 2, 3, 4, 5, 6, 7, 8]
BRIGHT    = [1, 2, 3, 4, 5, 6, 7, 8, 9]
BELL      = [1, 2.0, 2.76, 4.07, 5.43]     # idiophone-ish, inharmonic


def dawn():
    """Slow swell. Still the gentle one, but it now has a top end."""
    buf = blank(); period = 5.0
    for k in range(int(DURATION / period)):
        voice(buf, k * period, period * 0.98, 440.0, HARMONIC,
              attack=1.5, release=1.6, gain=0.95)
    return buf


def chime():
    """Three struck bell tones. Inharmonic partials keep it bell-like."""
    buf = blank(); period = 5.0
    for k in range(int(DURATION / period)):
        for j, f in enumerate([660.0, 554.37, 440.0]):
            voice(buf, k * period + j * 0.45, 3.2, f, BELL,
                  attack=0.006, release=1.6, gain=1.0, decay=0.8)
    return buf


def pulse():
    """Even, unhurried pulses with a bright leading edge."""
    buf = blank(); period = 1.1
    for k in range(int(DURATION / period)):
        voice(buf, k * period, 0.75, 587.33, HARMONIC,
              attack=0.03, release=0.34, gain=1.0)
        # A short high partial on the onset: transients this brief read as
        # "click" and cut through a noisy room far better than tone alone.
        voice(buf, k * period, 0.09, 2637.0, [1, 1.5],
              attack=0.004, release=0.07, gain=0.5, decay=14.0)
    return buf


def cascade():
    """Descending four-note figure. Harder to ignore, still musical."""
    buf = blank(); period = 2.5
    for k in range(int(DURATION / period)):
        for j, f in enumerate([880.0, 739.99, 622.25, 523.25]):
            voice(buf, k * period + j * 0.22, 1.05, f, HARMONIC,
                  attack=0.008, release=0.55, gain=1.0, decay=0.7)
    return buf


def reveille():
    """Repeated triplet, brighter and closer together. The insistent one."""
    buf = blank(); period = 1.6
    figure = [(0.00, 783.99), (0.16, 783.99), (0.32, 1046.50)]
    for k in range(int(DURATION / period)):
        for off, f in figure:
            voice(buf, k * period + off, 0.52, f, BRIGHT,
                  attack=0.006, release=0.26, gain=1.0, decay=1.0)
    return buf


def keepalive():
    """
    Near-silence, looped to hold the background audio session open.

    NOT digital zero on purpose: an audio session fed pure silence is a good
    way to get the app suspended, and some iOS versions treat it as "not
    playing". Three LSBs is about -80 dBFS - inaudible on any speaker, but
    unambiguously a signal. Bypasses the mastering chain below, which would
    otherwise normalise it into a siren.
    """
    n = int(KEEPALIVE_SECONDS * SR)
    return [(3.0 / 32767.0) * math.sin(2 * math.pi * 40.0 * (i / SR)) for i in range(n)]


VOICES = [
    ('dawn',     dawn),
    ('chime',    chime),
    ('pulse',    pulse),
    ('cascade',  cascade),
    ('reveille', reveille),
]
KEEPALIVE = ('keepalive', keepalive)


# --- mastering -------------------------------------------------------------

def high_pass(x, fs, f0, q=0.7071):
    """RBJ biquad. Removes what the speaker cannot reproduce anyway."""
    w0 = 2 * math.pi * f0 / fs
    c, s = math.cos(w0), math.sin(w0)
    alpha = s / (2 * q)
    b0, b1, b2 = (1 + c) / 2, -(1 + c), (1 + c) / 2
    a0, a1, a2 = 1 + alpha, -2 * c, 1 - alpha
    b0, b1, b2, a1, a2 = b0/a0, b1/a0, b2/a0, a1/a0, a2/a0
    out = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, v in enumerate(x):
        o = b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
        out[i] = o
        x2, x1 = x1, v
        y2, y1 = y1, o
    return out


def escalate(x, fs):
    """Open gentler, reach full level by ESCALATE_BY seconds, then hold."""
    n = len(x)
    ramp = int(ESCALATE_BY * fs)
    out = [0.0] * n
    for i, v in enumerate(x):
        if i >= ramp:
            g = 1.0
        else:
            # smoothstep, so the rise has no audible corner
            t = i / ramp
            g = ESCALATE_FROM + (1.0 - ESCALATE_FROM) * (t * t * (3 - 2 * t))
        out[i] = v * g
    return out


def compress(x, fs, thresh_db=COMP_THRESH_DB, ratio=COMP_RATIO,
             attack_ms=5.0, release_ms=120.0):
    """Feed-forward compressor: lifts the average toward the peak."""
    thr = 10 ** (thresh_db / 20.0)
    at = math.exp(-1.0 / (fs * attack_ms / 1000.0))
    rt = math.exp(-1.0 / (fs * release_ms / 1000.0))
    envv = 0.0
    out = [0.0] * len(x)
    for i, s in enumerate(x):
        a = abs(s)
        envv = at * envv + (1 - at) * a if a > envv else rt * envv + (1 - rt) * a
        if envv > thr:
            g = (thr + (envv - thr) / ratio) / envv
        else:
            g = 1.0
        out[i] = s * g
    return out


def soft_limit(x, drive=LIMIT_DRIVE):
    """
    tanh saturation. Catches peaks without the hard edges of clipping, and the
    harmonics it adds land in the upper octaves - which here is a bonus.
    """
    k = math.tanh(drive)
    return [math.tanh(drive * v) / k for v in x]


def normalise_peak(x, target_db=TARGET_PEAK_DB):
    peak = max(abs(v) for v in x) or 1.0
    target = 10 ** (target_db / 20.0)
    g = target / peak
    return [v * g for v in x]


def master(x, fs):
    """The chain every alarm tone goes through. keepalive skips it."""
    y = high_pass(x, fs, HP_HZ)
    y = escalate(y, fs)
    y = compress(y, fs)
    y = soft_limit(y)
    return normalise_peak(y)


def write_wav(path, samples, fade_s=0.02):
    fade = int(fade_s * SR)
    n = len(samples)
    pcm = array.array('h')
    for i, s in enumerate(samples):
        g = 1.0
        if i < fade:       g = i / fade
        elif i > n - fade: g = max(0.0, (n - i) / fade)
        v = int(round(max(-32767, min(32767, s * g * 32767))))
        pcm.append(v)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return os.path.getsize(path)


def main():
    web = os.path.join(APP, 'public', 'sounds')
    ios = os.path.join(APP, 'ios', 'App', 'App')
    has_ios = os.path.isdir(ios)
    print('%-10s %8s %9s %8s  %s' % ('name', 'seconds', 'peak dB', 'KiB', 'written to'))
    for name, fn in VOICES + [KEEPALIVE]:
        samples = fn()
        if name != 'keepalive':
            samples = master(samples, SR)
        size = write_wav(os.path.join(web, name + '.wav'), samples)
        if has_ios:
            write_wav(os.path.join(ios, name + '.wav'), samples)
        secs = len(samples) / SR
        peak = max(abs(s) for s in samples) or 1e-9
        assert secs < 30, '%s is %.1fs - iOS ignores anything over 30s' % (name, secs)
        assert peak <= 1.0, '%s clips' % name
        print('%-10s %8.1f %9.1f %8.0f  %s' % (
            name, secs, 20 * math.log10(peak), size / 1024.0,
            'public/sounds + ios bundle root' if has_ios else 'public/sounds'))


if __name__ == '__main__':
    main()
