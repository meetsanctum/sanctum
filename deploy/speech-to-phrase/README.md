# Speech-to-Phrase for Sanctum

Sanctum publishes this standalone image for speech to text. It recognizes
the sentences a client teaches it and returns an empty transcript for speech
outside that grammar.

It is [Speech-to-Phrase](https://github.com/OHF-Voice/apps/tree/main/speech-to-phrase)
2.x by the Open Home Foundation, built from a pinned commit on plain Debian,
with [`sanctum_server.py`](sanctum_server.py) as its entry point in place of
Home Assistant's add-on. That runs upstream's Wyoming server only, on port
10300, with no web UI and no Home Assistant. It adds two events:

- **`train`** accepts `{ token, language, backend, model, templates, lists }`,
  with sentence templates and the values for their named blanks. `backend`
  and `model` name the recognition model for the language, as Sanctum's
  language catalog does. The server takes only `nemo` and the model upstream
  lists for the lesson's language. A lesson that omits them gets that same
  model. List names must be lowercase identifiers in Unicode NFC form, such
  as `room`. Set `SANCTUM_TRAIN_TOKEN` in the container and send its value
  as `token`. With the variable unset, training is disabled. Use a private
  network or a secure transport when sending the token, since Wyoming over
  TCP sends it in clear text.
  The server answers `trained` with a digest once the new grammar is loaded
  and saved in `/data`. The previous grammar stays active during training.
  A repeated lesson returns the same digest immediately. What `/data` keeps
  names the model, so a restart loads the same one; an older image reads the
  rest and ignores it.
- **`voice-started`** is sent once per utterance when the server detects
  speech. Its detector ends the utterance after 0.7 s of silence and sends
  the transcript.

The server limits lessons by input size and by the expansion work the
grammar compiler performs. Each Wyoming event can carry a JSON body of up
to 4 MiB and a binary payload of up to 1 MiB.

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
  the first time a lesson needs them, and are not in the image:
  - English:
    [Parakeet TDT-CTC 110M](https://huggingface.co/nvidia/parakeet-tdt_ctc-110m)
    by NVIDIA, under CC BY 4.0.
  - German: Citrinet 1024 (`stt_de_citrinet_1024`) by NVIDIA, under CC BY 4.0.
