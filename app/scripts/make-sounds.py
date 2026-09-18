#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generates the alarm sounds, so the repo owns them outright.

Nothing is sourced or sampled: every tone is synthesised from sine partials
here. That keeps the repo self-contained, leaves no licensing question if this
ever ships paid, and means the set can be re-tuned and regenerated at will.

    python3 scripts/make-sounds.py

Writes 16-bit mono linear-PCM WAV to BOTH places iOS needs them, because it
treats them as two unrelated things:

  public/sounds/<name>.wav   - bundled as a web asset, used by the ring screen
  ios/App/App/<name>.wav     - bundle root, used as the notification sound

Apple's rules these files have to satisfy:
  * under 30 seconds, or iOS silently substitutes the default sound
  * linear PCM / MA4 / u-law / a-law, in .caf, .wav or .aiff
  * at the bundle root (or Library/Sounds), never in a subdirectory

The brief: a 6am alarm for someone who chose a push-up app. Gentle to
insistent, nothing that sounds like a car alarm.
"""
import array, math, os, struct, wave

SR       = 22050        # plenty for tones; halves the file size vs 44.1k
DURATION = 20.0         # comfortably inside Apple's 30s ceiling
PEAK     = 0.72         # leaves headroom so nothing clips on a phone speaker
HERE     = os.path.dirname(os.path.abspath(__file__))
APP      = os.path.dirname(HERE)

def env(t, dur, attack, release):
    """Attack/release envelope. Never zero-length: an instant edge clicks."""
    a = max(attack, 0.005)
    r = max(release, 0.005)
    if t < a:            return t / a
    if t > dur - r:      return max(0.0, (dur - t) / r)
    return 1.0

def partials(buf, start, dur, freq, harmonics, attack, release, gain=1.0, decay=0.0):
    """Add one voice: a fundamental plus scaled harmonics, enveloped."""
    i0 = int(start * SR)
    n  = int(dur * SR)
    for i in range(n):
        if i0 + i >= len(buf): break
        t = i / SR
        e = env(t, dur, attack, release)
        if decay: e *= math.exp(-decay * t)
        s = 0.0
        for mult, amp in harmonics:
            s += amp * math.sin(2 * math.pi * freq * mult * t)
        buf[i0 + i] += s * e * gain

def blank():
    return [0.0] * int(DURATION * SR)

# --- the five voices, gentle -> insistent ---------------------------------

def dawn():
    """Slow swell on a fifth. Meant to surface you, not startle you."""
    buf = blank(); period = 5.0
    for k in range(int(DURATION / period)):
        partials(buf, k * period, period * 0.98, 293.66,      # D4
                 [(1, 0.55), (1.5, 0.28), (2, 0.12), (3, 0.04)],
                 attack=1.6, release=1.6, gain=0.9)
    return buf

def chime():
    """Three struck bell tones, decaying. Inharmonic partials = bell-like."""
    buf = blank(); period = 5.0
    notes = [587.33, 493.88, 392.00]                          # D5 B4 G4
    for k in range(int(DURATION / period)):
        for j, f in enumerate(notes):
            partials(buf, k * period + j * 0.45, 2.6, f,
                     [(1, 0.5), (2.0, 0.22), (2.41, 0.14), (3.0, 0.07)],
                     attack=0.006, release=1.4, gain=0.85, decay=1.5)
    return buf

def pulse():
    """Even, unhurried pulses. The steady one."""
    buf = blank(); period = 1.2
    for k in range(int(DURATION / period)):
        partials(buf, k * period, 0.5, 440.0,                 # A4
                 [(1, 0.5), (2, 0.16), (3, 0.06)],
                 attack=0.04, release=0.3, gain=0.95)
    return buf

def cascade():
    """Descending four-note figure. Harder to sleep through, still musical."""
    buf = blank(); period = 2.5
    notes = [783.99, 659.25, 523.25, 440.00]                  # G5 E5 C5 A4
    for k in range(int(DURATION / period)):
        for j, f in enumerate(notes):
            partials(buf, k * period + j * 0.22, 0.85, f,
                     [(1, 0.48), (2, 0.2), (3, 0.09), (4, 0.04)],
                     attack=0.01, release=0.5, gain=0.95, decay=1.1)
    return buf

def reveille():
    """Repeated triplet, brighter and closer together. The insistent one."""
    buf = blank(); period = 1.6
    figure = [(0.00, 587.33), (0.16, 587.33), (0.32, 783.99)]  # D5 D5 G5
    for k in range(int(DURATION / period)):
        for off, f in figure:
            partials(buf, k * period + off, 0.42, f,
                     [(1, 0.46), (2, 0.24), (3, 0.12), (5, 0.05)],
                     attack=0.008, release=0.22, gain=1.0, decay=1.8)
    return buf

VOICES = [
    ('dawn',     dawn),
    ('chime',    chime),
    ('pulse',    pulse),
    ('cascade',  cascade),
    ('reveille', reveille),
]

def write_wav(path, samples):
    peak = max(abs(s) for s in samples) or 1.0
    scale = (PEAK / peak) * 32767
    # Fade the very start and end so a looping in-app playback has no click.
    fade = int(0.02 * SR)
    pcm = array.array('h')
    n = len(samples)
    for i, s in enumerate(samples):
        g = 1.0
        if i < fade:          g = i / fade
        elif i > n - fade:    g = max(0.0, (n - i) / fade)
        v = int(max(-32767, min(32767, s * scale * g)))
        pcm.append(v)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return os.path.getsize(path)

def main():
    web = os.path.join(APP, 'public', 'sounds')
    ios = os.path.join(APP, 'ios', 'App', 'App')
    print('%-10s %8s %8s  %s' % ('name', 'seconds', 'KiB', 'written to'))
    for name, fn in VOICES:
        samples = fn()
        size = write_wav(os.path.join(web, name + '.wav'), samples)
        if os.path.isdir(os.path.dirname(ios)):
            write_wav(os.path.join(ios, name + '.wav'), samples)
            where = 'public/sounds + ios bundle root'
        else:
            where = 'public/sounds (no ios/ dir)'
        secs = len(samples) / SR
        assert secs < 30, '%s is %.1fs - iOS ignores anything over 30s' % (name, secs)
        print('%-10s %8.1f %8.0f  %s' % (name, secs, size / 1024.0, where))

if __name__ == '__main__':
    main()
