"""Regression tests for the Speech-to-Phrase image's Wyoming entry point."""

import asyncio
import tempfile
import unittest
from pathlib import Path
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
        self.enterContext(
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
    def test_normalized_list_keys_are_unique(self):
        lesson = {**LESSON, "lists": {"Room": ["Kitchen"]}}
        self.assertEqual(server._lesson(lesson)["lists"], {"room": ["Kitchen"]})
        lesson["lists"]["room"] = ["Hall"]
        with self.assertRaisesRegex(ValueError, "duplicate list name"):
            server._lesson(lesson)

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
