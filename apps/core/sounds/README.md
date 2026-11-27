# Smart speakers' chimes

The sounds the core plays on a smart speaker in place of words, kept ready
as 22,050 Hz, 16-bit mono WAV, the sound a speaker's announcements are made
from:

- **`success.wav`** plays when a request only confirms what worked, such as
  "Turn off the Office lights".
- **`error.wav`** plays after a request that failed, as the speaker shows its
  error.

They are the success and error cues of [Cuelume](https://cuelume.dev/)'s
`press` theme, by Daniel Belyi, as its `play()` sounds them at normal
emphasis and full volume. Cuelume synthesizes its cues with Web Audio in a
browser, so [`render.mjs`](render.mjs) renders them once offline with
[node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api), at
Cuelume's own level, ending where their ring falls 60 dB below its peak. To
render them again, in an empty folder:

```sh
npm install cuelume@0.2.10 node-web-audio-api@2.3.0
node <path to this folder>/render.mjs
```

It writes the same files each time.

## Licences

- **`success.wav` and `error.wav`** are rendered from Cuelume 0.2.10, under
  the MIT licence, Copyright (c) 2026 Daniel Belyi:
  [`LICENSE-cuelume`](LICENSE-cuelume).
- **`render.mjs`** and this README are Sanctum's, under the repository's
  AGPL-3.0-only like the rest of the core.
