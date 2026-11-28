import { useRef, useState } from "react";

export function useCopyCode() {
  const [status, setStatus] = useState<"copied" | "failed">();
  const codeText = useRef<HTMLSpanElement>(null);

  async function copy(code: string, signal: AbortSignal) {
    try {
      await navigator.clipboard.writeText(code);
      if (!signal.aborted) setStatus("copied");
    } catch {
      if (signal.aborted) return;
      setStatus("failed");
      if (codeText.current)
        window.getSelection()?.selectAllChildren(codeText.current);
    }
  }

  const message =
    status === "failed"
      ? "Couldn’t copy the code. Copy it manually from the text above."
      : status === "copied"
        ? "Copied"
        : "";

  return { codeText, status, message, copy, reset: () => setStatus(undefined) };
}
