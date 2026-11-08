#!/usr/bin/env python3
"""
Generates the app icon: a sun cresting a horizon, in the app's own warm
gradient - the same stops as the done-screen background in styles.css
(.done.warm), not a separate palette invented just for the icon. "Dawn" is
the name and the whole visual language already built around it; the icon
just says that in one glance.

Run: python3 scripts/make-icon.py
Writes directly into the Xcode asset catalog (single 1024x1024, no alpha -
Apple rejects an App Store icon with a transparency channel).
"""
from PIL import Image, ImageDraw
import os

SIZE = 1024
OUT = os.path.join(os.path.dirname(__file__), '..', 'ios', 'App', 'App',
                    'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png')

# Same stops as .done.warm in styles.css, extended one stop darker at the top
# (--night) since that gradient starts already mid-dusk - the icon has room
# to run the fuller night-to-dawn range.
STOPS = [
    (0.00, (0x0B, 0x10, 0x26)),   # --night
    (0.30, (0x2A, 0x1B, 0x3D)),   # plum
    (0.60, (0x6B, 0x3A, 0x5B)),   # mauve
    (0.82, (0xFF, 0x6B, 0x35)),   # --ember
    (1.00, (0xFF, 0xC1, 0x5E)),   # --gold
]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sky_color(t):
    t = max(0.0, min(1.0, t))
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t0 <= t <= t1:
            local = (t - t0) / (t1 - t0) if t1 > t0 else 0
            return lerp(c0, c1, local)
    return STOPS[-1][1]


def main():
    cx, cy, r = SIZE * 0.5, SIZE * 0.66, SIZE * 0.32
    horizon_top = cy - r * 0.18

    # The full gradient is compressed into the visible sky band (above the
    # horizon), not stretched across the whole canvas - otherwise its
    # richest stops (ember, gold) land underneath the horizon band and are
    # never actually seen.
    img = Image.new('RGB', (SIZE, SIZE))
    for y in range(SIZE):
        img.paste(Image.new('RGB', (SIZE, 1), sky_color(y / horizon_top)), (0, y))

    # The sun: concentric rings from a bright core out to the gold rim - a
    # cheap radial gradient that needs no extra dependency. Drawn largest
    # ring first so each smaller one overwrites the center correctly.
    draw = ImageDraw.Draw(img)
    core, rim = (255, 250, 238), (0xFF, 0xC1, 0x5E)
    STEPS = 80
    for i in range(STEPS, 0, -1):
        t = i / STEPS
        rr = r * t
        c = lerp(core, rim, t)
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=c)

    # Horizon: a solid night band covering a bit more than the lower half of
    # the sun, so it reads as cresting rather than fully risen or fully set.
    draw.rectangle([0, horizon_top, SIZE, SIZE], fill=STOPS[0][1])

    img.save(OUT)
    print(f'wrote {OUT} ({img.size[0]}x{img.size[1]}, {img.mode})')


if __name__ == '__main__':
    main()
