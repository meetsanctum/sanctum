# Backdrops

The landscapes behind the screens before the dashboard. Each is a photo from
Unsplash, free to use under the [Unsplash License](https://unsplash.com/license),
which asks for no credit; it is given here anyway.

| File                   | Photo                                                                                | By               |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------- |
| `misty-forest.webp`    | [Evergreen trees in dense mountain fog](https://unsplash.com/photos/BS-Uxe8wU5Y)     | Thomas Griesbeck |
| `lake-at-sundown.webp` | [Sundown over a Swiss lake](https://unsplash.com/photos/1ExecpaQ_ck)                 | Ante Hamersmit   |
| `red-dusk.webp`        | [Dramatic sunset over a dark mountain lake](https://unsplash.com/photos/umxkP4d251w) | Josh Behunin     |

Each is scaled to 960 px wide and blurred ahead of time so the page needs no
live blur. The Gaussian blur (Core Image's `CIGaussianBlur`) uses a sigma of
2% of that width. Before WebP encoding at quality 90, the image is darkened
to target a maximum of 105 per RGB channel under the sheet (10% to 90% across,
below the top 12%).
The photo's edges are extended before it is scaled, so no partly transparent
edge row blurs into a pale band. That is blurred enough that the landscape is
only vaguely recognisable, and small enough, about 6 KB, to scale up to any
screen. A new one needs its average colour in `src/backdrop.ts`, and the logo
keeping 3 : 1 over its sky.
