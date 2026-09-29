#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Acoustic guard rails for the alarm sounds.

    python3 scripts/verify-sounds.py

The first version of these sounds shipped inaudible on a phone speaker: peaks
looked fine, but 0-2% of the energy sat in the 2-4 kHz band the speaker can
actually reproduce, and up to 96% sat below 500 Hz where it cannot. Nothing in
the test suite could have caught that. This is that test.

Thresholds are set below the measured values with real margin, so ordinary
re-voicing is free but a change that makes the alarms quiet again fails.

Format checks live here too (duration, rate, channels, bit depth) because a
sound that breaks Apple's rules is silently replaced by the default, which is
the same failure wearing a different hat.

None of this proves the sounds are pleasant, or loud ENOUGH in a real bedroom.
Only listening on the device can tell you that.
"""
import importlib.util, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP  = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location('an', os.path.join(HERE, 'analyse-sounds.py'))
an = importlib.util.module_from_spec(spec); spec.loader.exec_module(an)

ALARMS = ['dawn', 'chime', 'pulse', 'cascade', 'reveille']

# Measured at the time of writing, for reference:
#   LUFS        -8.0 .. -10.5
#   loud 3s     -7.7 .. -9.8
#   2-4 kHz     30% .. 42%
#   speaker     -1.1 .. -2.5 dB
MIN_LUFS        = -12.0   # integrated
MIN_SHORT_TERM  = -11.0   # loudest 3 s
MIN_BAND_2_4K   = 20.0    # % of total energy
MIN_SPEAKER_DB  = -4.0    # after the phone-speaker curve
PEAK_MIN_DB     = -1.0    # loud...
PEAK_MAX_DB     = -0.1    # ...but never at full scale
MIN_ESCALATION  = 1.0     # dB louder late than early
MAX_SECONDS     = 30.0    # Apple ignores anything longer
KEEPALIVE_MAX_DB = -60.0  # must stay inaudible

passed = failed = 0

def check(label, ok, detail=''):
    global passed, failed
    if ok: passed += 1
    else:  failed += 1
    print('  %s  %s%s' % ('PASS' if ok else 'FAIL', label, ('  ' + detail) if detail else ''))

def both_locations(name):
    return [('web', os.path.join(APP, 'public', 'sounds', name + '.wav')),
            ('bundle', os.path.join(APP, 'ios', 'App', 'App', name + '.wav'))]

print('== alarm sounds: format ==')
for name in ALARMS:
    for where, path in both_locations(name):
        if not os.path.exists(path):
            check('%s (%s) exists' % (name, where), False, path); continue
        x, fs, ch, sw = an.read_wav(path)
        secs = len(x) / fs
        check('%s (%s) format' % (name, where),
              fs == 22050 and ch == 1 and sw == 2 and secs < MAX_SECONDS,
              '%.1fs %d-bit %dch %dHz' % (secs, sw * 8, ch, fs))

print('\n== alarm sounds: loudness ==')
for name in ALARMS:
    path = os.path.join(APP, 'public', 'sounds', name + '.wav')
    x, fs, ch, sw = an.read_wav(path)
    peak = max(abs(v) for v in x)
    peak_db = an.db(peak)
    integrated = an.lufs(x, fs)
    st = an.short_term_max(x, fs)
    power, binhz = an.spectrum(x, fs)
    bands = an.band_energy(power, binhz, an.BANDS)
    spk = an.speaker_weighted_db(power, binhz)
    early = an.short_term_max(x[:int(6 * fs)], fs, 2.0)
    late = an.short_term_max(x[int(10 * fs):], fs, 2.0)

    check('%-9s peak is near full scale, not over' % name,
          PEAK_MIN_DB <= peak_db <= PEAK_MAX_DB, '%.2f dBFS' % peak_db)
    check('%-9s does not clip' % name, peak < 1.0, '%.4f' % peak)
    check('%-9s integrated loudness' % name, integrated >= MIN_LUFS,
          '%.1f LUFS (floor %.1f)' % (integrated, MIN_LUFS))
    check('%-9s loudest 3s' % name, st >= MIN_SHORT_TERM,
          '%.1f LUFS (floor %.1f)' % (st, MIN_SHORT_TERM))
    check('%-9s energy in 2-4 kHz' % name, bands[3] >= MIN_BAND_2_4K,
          '%.1f%% (floor %.0f%%)' % (bands[3], MIN_BAND_2_4K))
    check('%-9s survives the speaker curve' % name, spk >= MIN_SPEAKER_DB,
          '%+.1f dB (floor %+.1f)' % (spk, MIN_SPEAKER_DB))
    check('%-9s escalates within the 20s' % name, late >= early + MIN_ESCALATION,
          'early %.1f -> late %.1f (%+.1f dB)' % (early, late, late - early))

print('\n== keepalive stays inaudible ==')
for where, path in both_locations('keepalive'):
    x, fs, ch, sw = an.read_wav(path)
    peak_db = an.db(max(abs(v) for v in x))
    check('keepalive (%s) is silent to the ear' % where, peak_db <= KEEPALIVE_MAX_DB,
          '%.1f dBFS (ceiling %.1f)' % (peak_db, KEEPALIVE_MAX_DB))
    check('keepalive (%s) is not digital zero' % where, peak_db > -120.0,
          'a session fed pure silence can be suspended')

print('\n  %d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
