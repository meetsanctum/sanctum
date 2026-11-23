import type { CoreCalls } from "./context.js";
import type { ModelAnswer, ModelAnswerPiece, ModelQuestion } from "./models.js";

// An answer from the home's AI model, read by its handle: the core opens it
// at once and keeps its pieces, and each read asks for those after the last
// one read, waiting a moment for more. One message a call can't stream, so
// a long answer is many short reads.

export function modelAnswerOf(
  core: Pick<CoreCalls, "openModel" | "readModel" | "cancelModel">,
  question: ModelQuestion,
): ModelAnswer {
  const opened = core.openModel(question);
  // Its refusal reaches whoever reads the answer, not the process.
  opened.catch(() => undefined);
  async function* pieces(): AsyncGenerator<ModelAnswerPiece> {
    const { handle } = await opened;
    let after = 0;
    for (;;) {
      const read = await core.readModel({ handle, after });
      after += read.length;
      for (const piece of read) {
        yield piece;
        if (piece.type === "end") return;
      }
    }
  }

  return {
    [Symbol.asyncIterator]: pieces,
    async text() {
      let text = "";
      for await (const piece of pieces()) {
        if (piece.type === "text") text += piece.text;
      }
      return text;
    },
    async cancel() {
      let handle: string;
      try {
        ({ handle } = await opened);
      } catch {
        // Refused, so nothing is under way.
        return;
      }
      await core.cancelModel(handle);
    },
  };
}
