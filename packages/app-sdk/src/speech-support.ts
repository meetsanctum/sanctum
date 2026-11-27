import type { LanguageEntry } from "./languages.js";

export function supportsSpeech(entry: LanguageEntry): boolean {
  return entry.recognition !== null && entry.voice !== null;
}
