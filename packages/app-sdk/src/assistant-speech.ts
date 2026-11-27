import type { AppDefinition } from "./app-definition.js";
import { assistantAppId } from "./requests.js";
import { notUnderstoodIssues, sentenceIssues } from "./sentences.js";

// What only Sanctum's Assistant brings for smart speakers, checked as it is
// defined: its sentences and what it says for speech outside them.

export function assertAssistantSpeech(
  app: Pick<AppDefinition, "id" | "requests" | "sentences" | "notUnderstood">,
) {
  if (app.sentences !== undefined) {
    if (app.id !== assistantAppId) {
      throw new Error("Only Sanctum's Assistant brings sentences");
    }
    if (typeof app.requests !== "function") {
      throw new Error("An Assistant with sentences needs a requests handler");
    }
    const issues = sentenceIssues(app.sentences);
    if (issues.length > 0) throw new Error(issues.join("; "));
  }
  if (app.notUnderstood !== undefined) {
    if (app.id !== assistantAppId || app.sentences === undefined) {
      throw new Error(
        "Only Sanctum's Assistant, with its sentences, says what it didn't understand",
      );
    }
    const issues = notUnderstoodIssues(app.notUnderstood, app.sentences);
    if (issues.length > 0) throw new Error(issues.join("; "));
  }
}
