"""Regression tests for the Speech-to-Phrase image's Wyoming entry point."""

import asyncio
import tempfile
import unittest
from pathlib import Path
from threading import Event as ThreadEvent
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import sanctum_server as server
from endpointing import SAMPLES_PER_VAD_CHUNK, SileroEndpointDetector
from speech_to_phrase import templates
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.event import Event


TOKEN = "test-training-token"
LESSON = {"token": TOKEN, "language": "en", "templates": ["turn on the light"]}
FORMAT = {"rate": 16_000, "width": 2, "channels": 1}


class TrainingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.data = Path(tmp)
        self.taught = server.Taught(self.data, train_token=TOKEN)
        self.ensure = self.enterContext(
            patch.object(server.models, "ensure_model", return_value=self.data)
        )
        self.compiler = self.enterContext(
            patch.object(server.training, "train", side_effect=self.compile)
        )
        self.loader = self.enterContext(
            patch.object(server.wyoming_server, "GrammarHolder", side_effect=self.holder)
        )

    @staticmethod
    def compile(backend, model_dir, language, sentences, lists, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(sentences[0])
        path.with_suffix(".fst.tokens").write_text(sentences[0])
        return len(sentences)

    @staticmethod
    def holder(backend, model_dir, language, grammar, **options):
        return SimpleNamespace(
            language=language, file=grammar, ready=True, maybe_reload=AsyncMock()
        )

    async def test_training_requires_the_token(self):
        for lesson in ({**LESSON, "token": None}, {**LESSON, "token": "wrong token"}):
            reply = await server._train(self.taught, lesson)
            self.assertEqual(reply.data["code"], "unauthorized")
        disabled = server.Taught(self.data)
        reply = await server._train(disabled, LESSON)
        self.assertEqual(reply.data["code"], "unauthorized")
        self.compiler.assert_not_called()

    async def test_failed_state_write_preserves_the_grammar_and_retries(self):
        original = await server._train(self.taught, LESSON)
        holder = self.taught.holder
        lesson = {**LESSON, "templates": ["turn off the light"]}
        with (
            patch.object(self.taught, "write_state", side_effect=OSError("write failed")),
            self.assertLogs("sanctum", level="ERROR"),
        ):
            failed = await server._train(self.taught, lesson)
        self.assertEqual(failed.data["code"], "train-failed")
        self.assertIs(self.taught.holder, holder)
        restored = server.Taught(self.data)
        await restored.restore()
        self.assertEqual(restored.digest, original.data["digest"])
        self.assertEqual(restored.holder.file.read_text(), LESSON["templates"][0])
        retried = await server._train(self.taught, lesson)
        self.assertTrue(retried.data["changed"])
        self.assertTrue(self.taught.holder.file.with_suffix(".fst.tokens").is_file())
        await restored.restore()
        self.assertEqual(restored.digest, retried.data["digest"])
        self.assertEqual(restored.holder.file.read_text(), lesson["templates"][0])

    def test_a_lesson_takes_the_model_listed_for_its_language(self):
        # These are the backend and model pairs the core sends from its catalog.
        for language, backend, model, sentence in (
            ("en", "nemo", "stt_en_parakeet_tdt_ctc_110m", "turn on the light"),
            ("de", "nemo", "stt_de_citrinet_1024", "mach das licht an"),
        ):
            with self.subTest(language=language):
                lesson = {**LESSON, "language": language, "templates": [sentence]}
                named = server._lesson({**lesson, "backend": backend, "model": model})
                self.assertEqual(named["model"], model)
                self.assertEqual(server._lesson(lesson), named)

    def test_invalid_lesson_models_are_rejected(self):
        english = server.models.model_name_for("en", server.BACKEND)
        german = server.models.model_name_for("de", server.BACKEND)
        for lesson in (
            {**LESSON, "model": german},
            {**LESSON, "model": "../elsewhere"},
            {**LESSON, "model": None},
            {**LESSON, "backend": "coqui", "model": english},
            {**LESSON, "language": "xx"},
            {**LESSON, "language": None},
        ):
            with self.assertRaises(ValueError):
                server._lesson(lesson)

    def test_the_lesson_digest_changes_with_the_model(self):
        lesson = server._lesson(LESSON)
        self.assertNotEqual(
            server._digest(lesson), server._digest({**lesson, "model": "another-model"})
        )

    async def test_trains_with_the_lesson_model_and_keeps_it(self):
        german = server.models.model_name_for("de", server.BACKEND)
        lesson = {
            **LESSON,
            "language": "de",
            "model": german,
            "templates": ["mach das licht an"],
        }
        reply = await server._train(self.taught, lesson)
        self.assertTrue(reply.data["changed"])
        self.ensure.assert_called_with(german, self.data / "models")
        state = self.taught.read_state()
        self.assertEqual(
            state,
            {
                "version": 1,
                "language": "de",
                "model": german,
                "digest": reply.data["digest"],
            },
        )
        restored = server.Taught(self.data)
        self.ensure.reset_mock()
        await restored.restore()
        self.ensure.assert_called_once_with(german, self.data / "models")
        self.assertEqual(restored.digest, reply.data["digest"])
        self.assertEqual(restored.language, "de")

    async def test_restores_an_older_image_state_with_its_language_model(self):
        reply = await server._train(self.taught, LESSON)
        digest = reply.data["digest"]
        english = server.models.model_name_for("en", server.BACKEND)
        self.taught.state_path.write_text(
            server.json.dumps({"version": 1, "language": "en", "digest": digest})
        )
        restored = server.Taught(self.data)
        self.ensure.reset_mock()
        await restored.restore()
        self.ensure.assert_called_once_with(english, self.data / "models")
        self.assertEqual(restored.digest, digest)

    async def test_restore_refuses_a_model_for_another_language(self):
        reply = await server._train(self.taught, LESSON)
        digest = reply.data["digest"]
        self.taught.state_path.write_text(
            server.json.dumps(
                {
                    "version": 1,
                    "language": "en",
                    "model": server.models.model_name_for("de", server.BACKEND),
                    "digest": digest,
                }
            )
        )
        elsewhere = server.Taught(self.data)
        await elsewhere.restore()
        self.assertIsNone(elsewhere.digest)

    async def test_uncommitted_grammar_does_not_replace_the_saved_one(self):
        original = await server._train(self.taught, LESSON)
        lesson = {**LESSON, "templates": ["turn off the light"]}
        digest = server._digest(server._lesson(lesson))
        path = self.taught.grammar("en", digest)
        self.compile(None, None, None, lesson["templates"], {}, path)
        restored = server.Taught(self.data, train_token=TOKEN)
        await restored.restore()
        self.assertEqual(restored.holder.file.read_text(), LESSON["templates"][0])
        self.assertEqual(
            await server._train(restored, LESSON),
            Event("trained", {"changed": False, "digest": original.data["digest"]}),
        )

    async def test_current_lesson_answers_while_a_new_model_downloads(self):
        original = await server._train(self.taught, LESSON)
        lesson = {**LESSON, "language": "de", "templates": ["mach das licht an"]}
        loop = asyncio.get_running_loop()
        started = asyncio.Event()
        release = ThreadEvent()

        def stalled_download(*args):
            loop.call_soon_threadsafe(started.set)
            release.wait()
            raise TimeoutError("model download stalled")

        with (
            patch.object(server.models, "ensure_model", side_effect=stalled_download),
            self.assertLogs("sanctum", level="ERROR"),
        ):
            pending = asyncio.create_task(server._train(self.taught, lesson))
            try:
                await asyncio.wait_for(started.wait(), timeout=2)
                repeat = await asyncio.wait_for(
                    server._train(self.taught, LESSON), timeout=2
                )
                self.assertEqual(
                    repeat,
                    Event("trained", {"changed": False, "digest": original.data["digest"]}),
                )
            finally:
                release.set()
                failed = await pending
        self.assertEqual(failed.data["code"], "train-failed")
        self.assertEqual(self.taught.digest, original.data["digest"])
        self.assertTrue((await server._train(self.taught, lesson)).data["changed"])

    async def test_failed_grammar_load_keeps_the_active_model(self):
        await server._train(self.taught, LESSON)
        holder = self.taught.holder
        self.loader.side_effect = None
        self.loader.return_value = SimpleNamespace(ready=False, maybe_reload=AsyncMock())
        lesson = {**LESSON, "templates": ["turn off the light"]}
        with self.assertLogs("sanctum", level="ERROR"):
            reply = await server._train(self.taught, lesson)
        self.assertEqual(reply.data["code"], "train-failed")
        self.assertIs(self.taught.holder, holder)
        restored = server.Taught(self.data)
        with self.assertLogs("sanctum", level="ERROR"):
            await restored.restore()
        self.assertIsNone(restored.digest)
        self.assertEqual(restored.info.asr[0].models, [])

        self.loader.side_effect = self.holder
        self.assertTrue((await server._train(self.taught, lesson)).data["changed"])


class ModelDownloadTests(unittest.TestCase):
    def test_model_download_uses_a_socket_timeout(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(
                server.models.urllib.request, "urlopen", side_effect=TimeoutError
            ) as open_url,
        ):
            models_dir = Path(tmp) / "models"
            with self.assertRaises(TimeoutError):
                server.models.ensure_model("test-model", models_dir)
            open_url.assert_called_once_with(
                f"{server.models.HF_BASE}/test-model.tar.gz", timeout=30
            )
            self.assertFalse((models_dir / "test-model").exists())


class WyomingTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_event_accepts_header_and_body_data(self):
        reader = asyncio.StreamReader()
        reader.feed_data(
            b'{"type":"audio-chunk","data":{"rate":16000},'
            b'"data_length":11,"payload_length":2}\n{"width":2}\0\0'
        )
        self.assertEqual(
            await server._read_event(reader),
            Event("audio-chunk", {"rate": 16_000, "width": 2}, b"\0\0"),
        )

    async def test_size_limits_are_checked_before_either_body_is_read(self):
        reader = SimpleNamespace(
            readline=AsyncMock(
                return_value=b'{"type":"audio-chunk","data_length":3,"payload_length":5}\n'
            ),
            readexactly=AsyncMock(),
        )
        with patch.object(server, "MAX_EVENT_PAYLOAD", 4):
            with self.assertRaisesRegex(ValueError, "invalid Wyoming event length"):
                await server._read_event(reader)
        reader.readexactly.assert_not_awaited()

    async def test_audio_start_follows_the_current_grammar(self):
        taught = server.Taught(Path("."))
        listening = server.Listening(None, None, taught, 0.7)
        listening.write_event = AsyncMock()
        listening._decode_buffer = AsyncMock(return_value="matched")
        await listening.handle_event(AudioStart(**FORMAT).event())
        taught.holder = SimpleNamespace(language="en", maybe_reload=AsyncMock())
        await listening.handle_event(AudioStop().event())
        self.assertEqual(listening.write_event.await_args.args[0].data["text"], "")

        detector = SimpleNamespace(reset=lambda *args: None)
        with patch.object(server, "SileroEndpointDetector", return_value=detector):
            await listening.handle_event(AudioStart(**FORMAT).event())
            english = taught.holder
            taught.holder = SimpleNamespace(language="de", maybe_reload=AsyncMock())
            await listening.handle_event(AudioStop().event())
            reply = listening.write_event.await_args.args[0]
            self.assertEqual(reply.data["language"], "en")
            english.maybe_reload.assert_awaited_once()

            await listening.handle_event(AudioStart(**FORMAT).event())
            await listening.handle_event(AudioStop().event())
            reply = listening.write_event.await_args.args[0]
            self.assertEqual(reply.data["language"], "de")

    async def test_one_chunk_reports_voice_started_before_transcript(self):
        taught = server.Taught(Path("."))
        taught.holder = SimpleNamespace(language="en", maybe_reload=AsyncMock())
        listening = server.Listening(None, None, taught, 0.7)
        listening.write_event = AsyncMock()
        listening._decode_buffer = AsyncMock(return_value="matched")
        probabilities = iter([1.0] * 12 + [0.0] * 52)
        detector = SileroEndpointDetector(
            0.7,
            SimpleNamespace(
                reset=lambda: None, process_samples=lambda _: next(probabilities)
            ),
        )
        pcm = bytes(64 * SAMPLES_PER_VAD_CHUNK * FORMAT["width"])
        with patch.object(server, "SileroEndpointDetector", return_value=detector):
            await listening.handle_event(AudioStart(**FORMAT).event())
            await listening.handle_event(AudioChunk(**FORMAT, audio=pcm).event())
            await listening.handle_event(AudioStop().event())
        self.assertEqual(
            [call.args[0].type for call in listening.write_event.await_args_list],
            ["voice-started", "transcript"],
        )


class LessonTests(unittest.TestCase):
    def test_list_names_must_already_be_lowercase_and_nfc(self):
        for name in ("Room", "cafe\u0301"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "lowercase NFC identifier"):
                    server._lesson({**LESSON, "lists": {name: ["Kitchen"]}})
        lists = {"room": ["Kitchen"], "café": ["Coffee Shop"]}
        self.assertEqual(server._lesson({**LESSON, "lists": lists})["lists"], lists)

    def test_numeric_expansion_checks_the_budget_before_spelling_numbers(self):
        fst = templates.Fst(budget=templates._ExpansionBudget(remaining=5))
        with (
            patch.object(templates, "Fst", return_value=fst),
            patch.object(templates, "_spellout_variants") as spellout,
        ):
            with self.assertRaisesRegex(ValueError, "grammar expansion budget"):
                templates.templates_to_fst(["{1..10}"], None, "en")
        spellout.assert_not_called()

    def test_glued_fragments_budget_is_checked_before_tokenizing_variants(self):
        fst = templates.Fst(budget=templates._ExpansionBudget(remaining=8))
        with (
            patch.object(templates, "Fst", return_value=fst),
            patch.object(templates, "_compile_text_words") as compile_words,
        ):
            with self.assertRaisesRegex(ValueError, "grammar expansion budget"):
                templates.templates_to_fst(["[un][re]locked"], None, "en")
        compile_words.assert_not_called()
