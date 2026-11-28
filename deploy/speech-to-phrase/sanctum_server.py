"""Sanctum's entry point for Speech-to-Phrase 2.x.

Upstream's Wyoming server, run without Home Assistant. It adds two events:

- An authorized `train` event teaches it sentences in one language, with
  the recognition model the core names for that language: templates with
  blanks ("turn off the {room} lights") and the values of each blank. It
  answers `trained` once the grammar is in place, while the grammar it had
  keeps answering until then. A new language or model downloads first, the
  old one still answering. The same lesson again answers at once.
- A `voice-started` event says when speech began. The voice detector ends
  the utterance and sends the transcript. Speech outside the grammar
  gives an empty transcript.

What it was taught stays in /data, with its models, so it answers from its
last grammar and model after a restart until it is taught again.
"""

import argparse
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

# pylint: disable=wrong-import-position
import models  # noqa: E402
import training  # noqa: E402
import wyoming_server  # noqa: E402
from endpointing import SileroEndpointDetector, VoiceCommandSegmenter  # noqa: E402
from wyoming.asr import Transcript  # noqa: E402
from wyoming.audio import AudioChunk, AudioStart, AudioStop  # noqa: E402
from wyoming.error import Error  # noqa: E402
from wyoming.event import Event, async_get_stdin, async_get_stdout  # noqa: E402
from wyoming.info import Describe, Info  # noqa: E402
from wyoming.server import AsyncEventHandler, AsyncServer  # noqa: E402
from wyoming.vad import VoiceStarted  # noqa: E402

_LOGGER = logging.getLogger("sanctum")

# The core names a lesson's model from its language catalog (app-sdk's
# languages.ts): Parakeet for English and Citrinet for German, the models
# that heard every command right on a Pi 4. Only these languages can fetch
# models, and each takes the model upstream lists for this backend.
BACKEND = "nemo"
# The models used by Speech-to-Phrase 2.2.0, whose saved lessons omit the name.
LEGACY_MODELS = {"en": "stt_en_parakeet_tdt_ctc_110m", "de": "stt_de_citrinet_1024"}
_OMITTED_MODEL = object()

# What one lesson may hold, far above a home's sentences and names.
MAX_TEMPLATES = 2_000
MAX_LISTS = 64
MAX_VALUES = 2_000
MAX_TEXT = 512
MAX_EVENT_DATA = 4 * 1024 * 1024
MAX_EVENT_PAYLOAD = 1024 * 1024


class Taught:
    """The grammar the server answers from, and what it was taught."""

    def __init__(self, data: Path, train_token: Optional[str] = None) -> None:
        self.data = data
        self.train_token = train_token.encode("utf-8") if train_token else None
        self.state_path = data / "sanctum.json"
        self.language: Optional[str] = None
        self.digest: Optional[str] = None
        self.uses_legacy_digest = False
        self.holder: Optional[wyoming_server.GrammarHolder] = None
        self.info = wyoming_server.build_info(
            "en", "none", requires_external_vad=False
        )
        self.info.asr[0].models.clear()
        self.lock = asyncio.Lock()

    def grammar(self, language: str, digest: str) -> Path:
        return self.data / language / "grammars" / digest / "grammar.fst"

    def matching_digest(self, lesson: Dict[str, Any], digest: str) -> Optional[str]:
        language = lesson["language"]
        if self.language != language:
            return None
        if self.uses_legacy_digest and lesson["model"] == LEGACY_MODELS[language]:
            digest = _digest(
                {key: value for key, value in lesson.items() if key != "model"}
            )
        if self.digest == digest and self.grammar(language, digest).is_file():
            return digest
        return None

    def read_state(self) -> Dict[str, Any]:
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return {}
        return state if isinstance(state, dict) else {}

    def write_state(self, language: str, model: str, digest: str) -> None:
        state = {
            # The older image can still load a grammar built for its model.
            "version": 1 if model == LEGACY_MODELS.get(language) else 2,
            "language": language,
            "model": model,
            "digest": digest,
        }
        partial = self.state_path.with_name(".sanctum.json.tmp")
        partial.write_text(json.dumps(state))
        partial.replace(self.state_path)

    async def restore(self) -> None:
        state = self.read_state()
        language = state.get("language")
        digest = state.get("digest")
        version = state.get("version")
        if (
            type(version) is not int
            or version not in (1, 2)
            or not isinstance(language, str)
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            return
        legacy_digest = version == 1 and "model" not in state
        name = _model_for(
            language, LEGACY_MODELS.get(language) if legacy_digest else state.get("model")
        )
        if name is None:
            return
        grammar = self.grammar(language, digest)
        if not grammar.is_file():
            return
        try:
            model_dir = await asyncio.to_thread(
                models.ensure_model, name, self.data / "models"
            )
            holder, info = await _load_grammar(language, name, model_dir, grammar)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Couldn't load the saved %s grammar", language)
            return
        self.activate(holder, info, digest, uses_legacy_digest=legacy_digest)

    def activate(
        self,
        holder: wyoming_server.GrammarHolder,
        info: Info,
        digest: str,
        *,
        uses_legacy_digest: bool = False,
    ) -> None:
        self.info = info
        self.holder = holder
        self.language = holder.language
        self.digest = digest
        self.uses_legacy_digest = uses_legacy_digest


async def _load_grammar(
    language: str, name: str, model_dir: Path, grammar: Path
) -> tuple[wyoming_server.GrammarHolder, Info]:
    if not grammar.is_file():
        raise FileNotFoundError(grammar)
    holder = await asyncio.to_thread(
        wyoming_server.GrammarHolder,
        BACKEND,
        model_dir,
        language,
        grammar,
        default_max_score=models.default_max_score(BACKEND, name),
        token_bonus=models.default_token_bonus(BACKEND),
    )
    await holder.maybe_reload()
    if not holder.ready:
        raise ValueError("the recognizer could not load the grammar")
    return holder, wyoming_server.build_info(
        language, name, requires_external_vad=False
    )


def _model_for(language: Any, model: Any) -> Optional[str]:
    """The model for a language, as named or upstream's, if upstream lists it."""
    if not isinstance(language, str) or language not in LEGACY_MODELS:
        return None
    listed = models.model_name_for(language, BACKEND)
    return listed if model is _OMITTED_MODEL or model == listed else None


def _lesson(data: Any) -> Dict[str, Any]:
    """The lesson a `train` event carries, checked, or ValueError."""
    if not isinstance(data, dict):
        raise ValueError("a lesson is an object")
    language = data.get("language")
    backend = data.get("backend", BACKEND)
    if backend != BACKEND:
        raise ValueError(f"no recognizer for backend {backend!r}")
    model = _model_for(language, data.get("model", _OMITTED_MODEL))
    if model is None:
        raise ValueError(
            f"no model {data.get('model')!r} for language {language!r}"
            if "model" in data
            else f"no model for language {language!r}"
        )
    templates = data.get("templates")
    if (
        not isinstance(templates, list)
        or not 0 < len(templates) <= MAX_TEMPLATES
        or not all(
            isinstance(t, str) and 0 < len(t) <= MAX_TEXT for t in templates
        )
    ):
        raise ValueError("templates are 1 to 2,000 sentences")
    lists = data.get("lists", {})
    if not isinstance(lists, dict) or len(lists) > MAX_LISTS:
        raise ValueError("lists are up to 64 named lists")
    for name, values in lists.items():
        if (
            not isinstance(name, str)
            or not name.isidentifier()
            or name != name.lower()
            or not unicodedata.is_normalized("NFC", name)
        ):
            raise ValueError(f"list name {name!r} must be a lowercase NFC identifier")
        if (
            not isinstance(values, list)
            or len(values) > MAX_VALUES
            or not all(
                isinstance(v, str) and 0 < len(v) <= MAX_TEXT for v in values
            )
        ):
            raise ValueError(f"list {name!r} is up to 2,000 names")
    return {
        "language": language,
        "model": model,
        "templates": templates,
        "lists": lists,
    }


def _digest(lesson: Dict[str, Any]) -> str:
    text = json.dumps(lesson, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


async def _train(taught: Taught, data: Any) -> Event:
    """Teaches the server a lesson and answers how it went."""
    token = data.get("token") if isinstance(data, dict) else None
    if (
        not taught.train_token
        or not isinstance(token, str)
        or not hmac.compare_digest(
            token.encode("utf-8", errors="surrogatepass"),
            taught.train_token,
        )
    ):
        return Error(text="Training requires a valid token", code="unauthorized").event()
    try:
        lesson = _lesson(data)
        digest = _digest(lesson)
    except ValueError as error:
        return Error(text=str(error), code="invalid-lesson").event()
    language = lesson["language"]
    matched = taught.matching_digest(lesson, digest)
    if matched is not None:
        return Event("trained", {"digest": matched, "changed": False})
    async with taught.lock:
        # Another request may have taught this lesson while we waited.
        matched = taught.matching_digest(lesson, digest)
        if matched is not None:
            return Event("trained", {"digest": matched, "changed": False})
        grammar = taught.grammar(language, digest)
        previous = (
            taught.grammar(taught.language, taught.digest)
            if taught.language is not None and taught.digest is not None
            else None
        )
        try:
            name = lesson["model"]
            model_dir = await asyncio.to_thread(
                models.ensure_model, name, taught.data / "models"
            )
            count = await asyncio.to_thread(
                training.train,
                BACKEND,
                model_dir,
                language,
                lesson["templates"],
                lesson["lists"],
                grammar,
            )
            holder, info = await _load_grammar(language, name, model_dir, grammar)
            taught.write_state(language, name, digest)
        except Exception as error:  # noqa: BLE001
            if grammar != previous:
                shutil.rmtree(grammar.parent, ignore_errors=True)
            _LOGGER.exception("Training %s failed", language)
            return Error(text=str(error), code="train-failed").event()
        taught.activate(holder, info, digest)
        if previous is not None and previous != grammar:
            # Open utterances still hold the previously loaded recognizer.
            shutil.rmtree(previous.parent, ignore_errors=True)
        _LOGGER.info("Taught %d sentences in %s", count, language)
        return Event("trained", {"digest": digest, "changed": True})


async def _read_event(reader: asyncio.StreamReader) -> Optional[Event]:
    line = await reader.readline()
    if not line:
        return None
    header = json.loads(line)
    if not isinstance(header, dict) or not isinstance(header.get("type"), str):
        raise ValueError("invalid Wyoming event header")
    data_length = header.get("data_length", 0)
    payload_length = header.get("payload_length", 0)
    if (
        type(data_length) is not int
        or not 0 <= data_length <= MAX_EVENT_DATA
        or type(payload_length) is not int
        or not 0 <= payload_length <= MAX_EVENT_PAYLOAD
    ):
        raise ValueError("invalid Wyoming event length")
    data = header.get("data", {})
    if not isinstance(data, dict):
        raise ValueError("invalid Wyoming event data")
    if data_length:
        body = json.loads(await reader.readexactly(data_length))
        if not isinstance(body, dict):
            raise ValueError("invalid Wyoming event body")
        data.update(body)
    payload = await reader.readexactly(payload_length) if payload_length else None
    return Event(type=header["type"], data=data, payload=payload)


class VoiceOnset(VoiceCommandSegmenter):
    """Remember speech onset even when the command ends in the same chunk."""

    def __init__(self, silence_seconds: float) -> None:
        super().__init__(silence_seconds)
        self.started = False

    def process(self, chunk_seconds: float, speech_probability: float) -> bool:
        was_in_command = self.in_command
        listening = super().process(chunk_seconds, speech_probability)
        self.started |= self.in_command and not was_in_command
        return listening


class Listening(wyoming_server.S2PEventHandler):
    """A Wyoming connection that learns and selects a grammar per utterance."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        taught: Taught,
        vad_silence_seconds: float,
    ) -> None:
        super().__init__(
            reader,
            writer,
            holder=None,
            info=taught.info,
            vad_silence_seconds=vad_silence_seconds,
        )
        self._taught = taught
        self._onset: Optional[VoiceOnset] = None

    async def run(self) -> None:
        self._is_running = True
        try:
            while self._is_running:
                try:
                    event = await _read_event(self.reader)
                except (ValueError, RecursionError, asyncio.IncompleteReadError):
                    break
                if event is None or not await self.handle_event(event):
                    break
        finally:
            await self.disconnect()
            self.writer.close()

    async def _report_onset(self) -> None:
        if self._onset is not None and self._onset.started:
            self._onset.started = False
            await self.write_event(VoiceStarted().event())

    async def _finish_utterance(self) -> None:
        if self._finished:
            return
        await self._report_onset()
        if self._holder is None:
            self._finished = True
            await self.write_event(Transcript(text="").event())
        else:
            await super()._finish_utterance()
            self._holder = None

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            await self.write_event(self._taught.info.event())
        elif event.type == "train":
            await self.write_event(await _train(self._taught, event.data))
        elif AudioStart.is_type(event.type):
            self._holder = self._taught.holder
            self._finished = False
            if self._onset is not None:
                self._onset.started = False
            if self._holder is not None:
                if self._endpoint_detector is None:
                    seconds = self._vad_silence_seconds
                    self._onset = VoiceOnset(seconds)
                    self._endpoint_detector = SileroEndpointDetector(seconds)
                    # The pinned detector calls the segmenter for each VAD window.
                    self._endpoint_detector._segmenter = self._onset
                return await super().handle_event(event)
        elif AudioStop.is_type(event.type):
            await self._finish_utterance()
        elif AudioChunk.is_type(event.type) and self._holder is not None:
            handled = await super().handle_event(event)
            await self._report_onset()
            return handled
        return True


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="/data")
    ap.add_argument("--uri", default="tcp://0.0.0.0:10300")
    ap.add_argument("--vad-silence-seconds", type=float, default=0.7)
    ap.add_argument("--debug", action="store_true")
    cfg = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if cfg.debug else logging.INFO)

    data = Path(cfg.data)
    data.mkdir(parents=True, exist_ok=True)
    taught = Taught(data, train_token=os.environ.get("SANCTUM_TRAIN_TOKEN"))
    await taught.restore()

    def handler(reader: Any, writer: Any) -> AsyncEventHandler:
        return Listening(reader, writer, taught, cfg.vad_silence_seconds)

    _LOGGER.info(
        "Listening on %s (%s)", cfg.uri, taught.language or "not taught yet"
    )
    if urlparse(cfg.uri).scheme == "stdio":
        # Wyoming's stdio server reads events itself, bypassing the bounded reader.
        await handler(await async_get_stdin(), await async_get_stdout()).run()
    else:
        await AsyncServer.from_uri(cfg.uri).run(handler)


if __name__ == "__main__":
    asyncio.run(main())
