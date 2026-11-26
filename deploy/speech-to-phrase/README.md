# Speech-to-Phrase for Sanctum

The image Sanctum runs for speech to text: what a smart speaker heard,
turned into words, on the host. It knows only the sentences the core teaches
it, the home's commands with its rooms, lights and moods filled in, so speech
outside them comes back empty.

It is [Speech-to-Phrase](https://github.com/OHF-Voice/apps/tree/main/speech-to-phrase)
2.x by the Open Home Foundation, built from a pinned commit on plain Debian,
with [`sanctum_server.py`](sanctum_server.py) as its entry point in place of
Home Assistant's add-on. That runs upstream's Wyoming server only, on port
10300, with no web UI and no Home Assistant. It adds two events:

- **`train`**, from the core: `{ language, templates, lists }`, hassil
  templates with blanks and each blank's values. It answers `trained` with a
  digest of what it learned once the new grammar is in place, while the old
  one keeps answering. The same lesson again answers at once, and a new
  language downloads its model first.
- **`voice-started`**, to the core, once while it listens: speech began.
  Its own voice detector ends speech, after 0.7 s of silence, and answers
  the transcript then.

## Building it

```bash
docker build -t sanctum-speech-to-phrase deploy/speech-to-phrase
```

The Speech-to-Phrase workflow publishes it for amd64 and arm64 to
`ghcr.io/meetsanctum/sanctum-speech-to-phrase`, by the version in its
`speech-to-phrase-v*` tag. It changes only when this folder does, so
it keeps a version of its own.

## Licences

- **Speech-to-Phrase** and the recognition library it vendors are under the
  [Apache License 2.0](https://github.com/OHF-Voice/apps/blob/main/LICENSE).
- **`sanctum_server.py`** and this folder are Sanctum's, under the
  repository's AGPL-3.0-only like the rest of `deploy/`.
- **The models** download from the
  [rhasspy-speech dataset](https://huggingface.co/datasets/rhasspy/rhasspy-speech)
  the first time a language is taught, and are not in the image:
  - English:
    [Parakeet TDT-CTC 110M](https://huggingface.co/nvidia/parakeet-tdt_ctc-110m)
    by NVIDIA, under CC BY 4.0.
  - German: Citrinet 1024 (`stt_de_citrinet_1024`) by NVIDIA, under CC BY 4.0.
