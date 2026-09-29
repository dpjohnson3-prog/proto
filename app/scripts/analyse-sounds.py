#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Measures the alarm sounds, so "too quiet" is a number rather than an opinion.

    python3 scripts/analyse-sounds.py

Reports per sound:
  * peak dBFS and RMS dBFS
  * integrated loudness, ITU-R BS.1770-4 K-weighting with gating (LUFS)
  * where the energy actually sits, by octave-ish band
  * a speaker-weighted loudness: the same signal through an approximation of a
    phone speaker, which is what the sleeper actually hears

No numpy here, so the FFT and the biquads are hand-rolled. The K-weighting
filters are RBJ-cookbook designs at the file's own sample rate rather than the
48 kHz coefficients printed in BS.1770, which is an approximation - good to a
fraction of a dB for this purpose, and flagged rather than hidden.

The phone-speaker curve is an APPROXIMATION of a small sealed driver: steep
roll-off below ~500 Hz, most efficient across 2-5 kHz. It is not a measurement
of any particular iPhone. It is here to rank sounds against each other, not to
predict SPL.
"""
import cmath, math, os, sys, wave, array

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)

# Rough acoustic efficiency of a phone speaker, dB relative to its best band.
SPEAKER_CURVE = [
    (0,    150,  -40.0),
    (150,  300,  -30.0),
    (300,  500,  -18.0),
    (500,  1000,  -8.0),
    (1000, 2000,  -2.0),
    (2000, 5000,   0.0),   # most efficient, and where hearing is most sensitive
    (5000, 8000,  -3.0),
    (8000, 99999, -9.0),
]

BANDS = [(0, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000), (8000, 99999)]


def read_wav(path):
    with wave.open(path, 'rb') as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    a = array.array('h'); a.frombytes(raw)
    return [s / 32768.0 for s in a], sr, ch, sw


def db(x):
    return 20 * math.log10(x) if x > 1e-12 else -999.0


def biquad(x, b, a):
    b0, b1, b2 = b; a0, a1, a2 = a
    b0, b1, b2, a1, a2 = b0/a0, b1/a0, b2/a0, a1/a0, a2/a0
    y = [0.0] * len(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, s in enumerate(x):
        o = b0*s + b1*x1 + b2*x2 - a1*y1 - a2*y2
        y[i] = o
        x2, x1 = x1, s
        y2, y1 = y1, o
    return y


def high_shelf(fs, f0, gain_db, q):
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * math.pi * f0 / fs
    c, s = math.cos(w0), math.sin(w0)
    alpha = s / (2 * q)
    sa = 2 * math.sqrt(A) * alpha
    return ([A*((A+1) + (A-1)*c + sa), -2*A*((A-1) + (A+1)*c), A*((A+1) + (A-1)*c - sa)],
            [(A+1) - (A-1)*c + sa, 2*((A-1) - (A+1)*c), (A+1) - (A-1)*c - sa])


def high_pass(fs, f0, q):
    w0 = 2 * math.pi * f0 / fs
    c, s = math.cos(w0), math.sin(w0)
    alpha = s / (2 * q)
    return ([(1+c)/2, -(1+c), (1+c)/2], [1+alpha, -2*c, 1-alpha])


def k_weight(x, fs):
    b, a = high_shelf(fs, 1681.97, 3.999, 0.7071)
    y = biquad(x, b, a)
    b, a = high_pass(fs, 38.13, 0.5003)
    return biquad(y, b, a)


def short_term_max(x, fs, window=3.0):
    """
    Loudest 3-second window (BS.1770 short-term loudness, max).

    For an alarm this matters more than the integrated figure: these sounds
    deliberately open quiet and have gaps between notes, both of which drag the
    integrated average down without making the loud part any less loud.
    """
    y = k_weight(x, fs)
    n = int(window * fs)
    if len(y) < n:
        return -999.0
    hop = int(0.5 * fs)
    best = -999.0
    for i in range(0, len(y) - n + 1, hop):
        p = sum(v * v for v in y[i:i+n]) / n
        if p > 0:
            best = max(best, -0.691 + 10 * math.log10(p))
    return best


def lufs(x, fs):
    """Integrated loudness, BS.1770-4: K-weight, 400 ms blocks, 75% overlap, gated."""
    b, a = high_shelf(fs, 1681.97, 3.999, 0.7071)
    y = biquad(x, b, a)
    b, a = high_pass(fs, 38.13, 0.5003)
    y = biquad(y, b, a)

    block = int(0.400 * fs)
    hop = block // 4
    if len(y) < block:
        return -999.0
    powers = []
    for i in range(0, len(y) - block + 1, hop):
        s = sum(v * v for v in y[i:i+block]) / block
        powers.append(s)
    loud = [-0.691 + 10 * math.log10(p) if p > 0 else -999.0 for p in powers]

    keep = [p for p, l in zip(powers, loud) if l > -70.0]          # absolute gate
    if not keep:
        return -999.0
    rel = -0.691 + 10 * math.log10(sum(keep) / len(keep)) - 10.0   # relative gate
    keep2 = [p for p, l in zip(powers, loud) if l > -70.0 and l > rel]
    if not keep2:
        keep2 = keep
    return -0.691 + 10 * math.log10(sum(keep2) / len(keep2))


def fft(a):
    n = len(a)
    if n == 1:
        return a
    ev = fft(a[0::2]); od = fft(a[1::2])
    out = [0j] * n
    for k in range(n // 2):
        t = cmath.exp(-2j * math.pi * k / n) * od[k]
        out[k] = ev[k] + t
        out[k + n // 2] = ev[k] - t
    return out


def spectrum(x, fs, size=4096):
    """Average power spectrum over Hann-windowed frames."""
    win = [0.5 - 0.5 * math.cos(2 * math.pi * i / (size - 1)) for i in range(size)]
    acc = [0.0] * (size // 2)
    frames = 0
    for start in range(0, len(x) - size, size // 2):
        seg = [x[start + i] * win[i] for i in range(size)]
        sp = fft([complex(v, 0) for v in seg])
        for k in range(size // 2):
            acc[k] += abs(sp[k]) ** 2
        frames += 1
    if not frames:
        return [], 0
    return [v / frames for v in acc], fs / size


def band_energy(power, binhz, bands):
    out = []
    total = sum(power) or 1e-30
    for lo, hi in bands:
        e = sum(p for k, p in enumerate(power) if lo <= k * binhz < hi)
        out.append(100.0 * e / total)
    return out


def speaker_weighted_db(power, binhz):
    """Total energy after the speaker curve, relative to the unweighted total."""
    tot = sum(power) or 1e-30
    w = 0.0
    for k, p in enumerate(power):
        f = k * binhz
        g = next((g for lo, hi, g in SPEAKER_CURVE if lo <= f < hi), -40.0)
        w += p * (10 ** (g / 10.0))
    return 10 * math.log10(w / tot) if w > 0 else -999.0


def analyse(path):
    x, fs, ch, sw = read_wav(path)
    peak = max(abs(v) for v in x) if x else 0.0
    rms = math.sqrt(sum(v * v for v in x) / len(x)) if x else 0.0
    power, binhz = spectrum(x, fs)
    return {
        'name': os.path.basename(path).replace('.wav', ''),
        'secs': len(x) / fs, 'fs': fs, 'ch': ch, 'bits': sw * 8,
        'peak_db': db(peak), 'rms_db': db(rms), 'lufs': lufs(x, fs),
        'st_max': short_term_max(x, fs),
        'bands': band_energy(power, binhz, BANDS),
        'spk_db': speaker_weighted_db(power, binhz),
    }


def main(argv):
    names = argv[1:] or ['dawn', 'chime', 'pulse', 'cascade', 'reveille']
    rows = [analyse(os.path.join(APP, 'public', 'sounds', n + '.wav')) for n in names]

    print('%-10s %6s %5s %8s %8s %8s %9s   %s' %
          ('sound', 'secs', 'kHz', 'peak dB', 'RMS dB', 'LUFS', 'loud 3s', 'format'))
    for r in rows:
        print('%-10s %6.1f %5.1f %8.1f %8.1f %8.1f %9.1f   %d-bit %s' %
              (r['name'], r['secs'], r['fs']/1000.0, r['peak_db'], r['rms_db'],
               r['lufs'], r['st_max'], r['bits'], 'mono' if r['ch'] == 1 else 'stereo'))

    print('\nenergy by band (%% of total)')
    print('%-10s %8s %8s %8s %9s %8s %7s | %s' %
          ('sound', '<500Hz', '.5-1k', '1-2k', '2-4k *', '4-8k', '>8k', 'speaker-weighted'))
    for r in rows:
        b = r['bands']
        print('%-10s %7.1f%% %7.1f%% %7.1f%% %8.1f%% %7.1f%% %6.1f%% | %+.1f dB' %
              (r['name'], b[0], b[1], b[2], b[3], b[4], b[5], r['spk_db']))
    print('\n* 2-4 kHz is where a phone speaker is most efficient and hearing is most')
    print('  sensitive. Energy below ~500 Hz is largely wasted: the driver cannot')
    print('  move enough air to reproduce it at any useful level.')
    print('  "speaker-weighted" = total energy after the approximate speaker curve;')
    print('  less negative is louder in the room. It ranks sounds, it is not an SPL.')
    return rows


if __name__ == '__main__':
    main(sys.argv)
