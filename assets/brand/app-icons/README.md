# App icons

The approved 2026-11-03 icon family: mostly opaque foreground symbols,
fine edge highlights, gentle gradients and shallow depth. The PNG masters
are exports of the approved concept artwork, with the presentation labels
and background removed. They have transparent corners and a 256 × 256 px
canvas, enough for the 72 px app overview at 3× density.

Lossless WebP exports sit beside them. The shell's `AppIcon`
(`apps/client/src/app-icon.tsx`) selects artwork by the manifest's glyph and
colour; other pairs keep the standard line icon.

| App           | Glyph         | Colour   | Master                                                      |
| ------------- | ------------- | -------- | ----------------------------------------------------------- |
| Settings      | `settings`    | Graphite | <img src="settings.png" width="64" height="64" alt="">      |
| Moods         | `swatch-book` | Ember    | <img src="moods.png" width="64" height="64" alt="">         |
| Automations   | `sparkles`    | Blossom  | <img src="automations.png" width="64" height="64" alt="">   |
| Weather       | `cloud-sun`   | Sky      | <img src="weather.png" width="64" height="64" alt="">       |
| Natural light | `sun`         | Sun      | <img src="natural-light.png" width="64" height="64" alt=""> |
| Zigbee        | `radio-tower` | Graphite | <img src="zigbee.png" width="64" height="64" alt="">        |

Moods owns the colour swatches, Automations the two sparkles.
Zigbee keeps the radio symbol rather than the Zigbee logo, which needs the
Connectivity Standards Alliance's permission.

To regenerate an export from a master, run from the repository root:

```sh
cwebp -lossless -m 6 assets/brand/app-icons/moods.png \
  -o assets/brand/app-icons/moods.webp
```

The WebP pixels, including alpha, match the PNG master. Keep the artwork
itself unchanged when optimizing exports. These are app icons, not launcher
icons for the Sanctum client, which retain the knot.
