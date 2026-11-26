"""Sanctum's entry point for Speech-to-Phrase 2.x.

Upstream's Wyoming server, run without Home Assistant. Two things are added
over Wyoming, both from the core:

- A `train` event teaches it the home's sentences in one language: hassil
  templates with blanks ("turn off the {room} lights") and the values of each
  blank. It answers `trained` once the grammar is in place, while the grammar
  it had keeps answering until then. A new language downloads its model
  first, the old one still answering. The same sentences again answer at
  once.
- While it listens, a `voice-started` event says when speech began, so the
  core can end a run in which nobody spoke. Its voice detector ends speech
  and answers the transcript straight away; speech outside the grammar
  answers an empty one.

What it was taught stays in /data, with its models, so it answers from its
last grammar after a restart until it is taught again.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

# pylint: disable=wrong-import-position
import models  # noqa: E402
import training  # noqa: E402
import wyoming_server  # noqa: E402
from wyoming.asr import Transcript  # noqa: E402
from wyoming.audio import AudioChunk, AudioStart, AudioStop  # noqa: E402
from wyoming.error import Error  # noqa: E402
from wyoming.event import Event  # noqa: E402
from wyoming.info import Describe  # noqa: E402
from wyoming.server import AsyncEventHandler, AsyncServer  # noqa: E402
from wyoming.vad import VoiceStarted  # noqa: E402

_LOGGER = logging.getLogger("sanctum")

# Parakeet for English and Citrinet for German: the models that heard every
# command right on a Pi 4.
BACKEND = "nemo"
LANGUAGES = ("en", "de")

# What one lesson may hold, far above a home's sentences and names.
MAX_TEMPLATES = 2_000
MAX_LISTS = 64
MAX_VALUES = 2_000
MAX_TEXT = 512


class Taught:
    """The grammar the server answers from, and what it was taught."""

    def __init__(self, data: Path) -> None:
        self.data = data
        self.state_path = data / "sanctum.json"
        self.language: Optional[str] = None
        self.digest: Optional[str] = None
        self.holder: Optional[wyoming_server.GrammarHolder] = None
        self.info = wyoming_server.build_info(
            "en", "none", requires_external_vad=False
        )
        self.lock = asyncio.Lock()

    def grammar(self, language: str) -> Path:
        return self.data / language / "grammar.fst"

    def read_state(self) -> Dict[str, Any]:
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return {}
        return state if isinstance(state, dict) else {}

    def write_state(self) -> None:
        state = {"language": self.language, "digest": self.digest}
        partial = self.state_path.with_name(".sanctum.json.tmp")
        partial.write_text(json.dumps(state))
        partial.replace(self.state_path)

    async def load(self, language: str) -> None:
        """Answers from `language`'s grammar, its model downloaded if absent."""
        name = models.model_name_for(language, BACKEND)
        loop = asyncio.get_running_loop()
        model_dir = await loop.run_in_executor(
            None, models.ensure_model, name, self.data / "models"
        )
        holder = await loop.run_in_executor(
            None,
            lambda: wyoming_server.GrammarHolder(
                BACKEND,
                model_dir,
                language,
                self.grammar(language),
                default_max_score=models.default_max_score(BACKEND, name),
                token_bonus=models.default_token_bonus(BACKEND),
            ),
        )
        await holder.maybe_reload()
        self.holder = holder
        self.language = language
        self.info = wyoming_server.build_info(
            language, name, requires_external_vad=False
        )


def _lesson(data: Any) -> Dict[str, Any]:
    """The lesson a `train` event carries, checked, or ValueError."""
    if not isinstance(data, dict):
        raise ValueError("a lesson is an object")
    language = data.get("language")
    if language not in LANGUAGES:
        raise ValueError(f"no model for language {language!r}")
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
    checked: Dict[str, List[str]] = {}
    for name, values in lists.items():
        if (
            not isinstance(name, str)
            or not name.isidentifier()
            or not isinstance(values, list)
            or len(values) > MAX_VALUES
            or not all(
                isinstance(v, str) and 0 < len(v) <= MAX_TEXT for v in values
            )
        ):
            raise ValueError(f"list {name!r} is up to 2,000 names")
        checked[name] = values
    return {"language": language, "templates": templates, "lists": checked}


def _digest(lesson: Dict[str, Any]) -> str:
    text = json.dumps(lesson, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


async def _train(taught: Taught, data: Any) -> Event:
    """Teaches the server a lesson and answers how it went."""
    try:
        lesson = _lesson(data)
    except ValueError as error:
        return Error(text=str(error), code="invalid-lesson").event()
    digest = _digest(lesson)
    language = lesson["language"]
    async with taught.lock:
        grammar = taught.grammar(language)
        if (
            taught.digest == digest
            and taught.language == language
            and grammar.exists()
        ):
            return Event("trained", {"digest": digest, "changed": False})
        loop = asyncio.get_running_loop()
        try:
            name = models.model_name_for(language, BACKEND)
            model_dir = await loop.run_in_executor(
                None, models.ensure_model, name, taught.data / "models"
            )
            count = await loop.run_in_executor(
                None,
                training.train,
                BACKEND,
                model_dir,
                language,
                lesson["templates"],
                lesson["lists"],
                grammar,
            )
            if taught.language != language or taught.holder is None:
                await taught.load(language)
            else:
                await taught.holder.maybe_reload()
        except Exception as error:  # noqa: BLE001
            _LOGGER.exception("Training %s failed", language)
            return Error(text=str(error), code="train-failed").event()
        taught.digest = digest
        taught.write_state()
        _LOGGER.info("Taught %d sentences in %s", count, language)
        return Event("trained", {"digest": digest, "changed": True})


class Listening(wyoming_server.S2PEventHandler):
    """Upstream's handler, which also says when speech began and learns."""

    def __init__(self, *args: Any, taught: Taught, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._taught = taught
        self._voice = False

    async def handle_event(self, event: Event) -> bool:
        if event.type == "train":
            await self.write_event(await _train(self._taught, event.data))
            return True
        if AudioStart.is_type(event.type):
            self._voice = False
        handled = await super().handle_event(event)
        detector = self._endpoint_detector
        if (
            AudioChunk.is_type(event.type)
            and not self._voice
            and detector is not None
            # pylint: disable-next=protected-access
            and detector._segmenter.in_command
        ):
            self._voice = True
            await self.write_event(VoiceStarted().event())
        return handled


class NotTaught(AsyncEventHandler):
    """Before any lesson: it describes itself, learns, and hears nothing."""

    def __init__(self, *args: Any, taught: Taught, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._taught = taught

    async def handle_event(self, event: Event) -> bool:
        if Describe.is_type(event.type):
            await self.write_event(self._taught.info.event())
        elif event.type == "train":
            await self.write_event(await _train(self._taught, event.data))
        elif AudioStop.is_type(event.type):
            await self.write_event(Transcript(text="").event())
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
    taught = Taught(data)
    state = taught.read_state()
    language = state.get("language")
    if language in LANGUAGES and taught.grammar(language).exists():
        try:
            await taught.load(language)
            taught.digest = state.get("digest")
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Couldn't load the %s grammar it was taught", language)

    def handler(reader: Any, writer: Any) -> AsyncEventHandler:
        # Each connection hears with the grammar there is as it connects.
        if taught.holder is None:
            return NotTaught(reader, writer, taught=taught)
        return Listening(
            reader,
            writer,
            holder=taught.holder,
            info=taught.info,
            vad_silence_seconds=cfg.vad_silence_seconds,
            taught=taught,
        )

    server = AsyncServer.from_uri(cfg.uri)
    _LOGGER.info(
        "Listening on %s (%s)", cfg.uri, taught.language or "not taught yet"
    )
    await server.run(handler)


if __name__ == "__main__":
    asyncio.run(main())
