"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// The line to hand an agent, with Copy beside it. Copy puts the line on the
// clipboard and says so on the button for a moment. Where the browser
// refuses, it selects the line instead, ready to copy by hand.
export function CopyPrompt(props: { children: ReactNode }) {
  const line = useRef<HTMLParagraphElement>(null);
  const [isCopied, setCopied] = useState(false);

  useEffect(() => {
    if (!isCopied) return;
    const restore = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(restore);
  }, [isCopied]);

  async function copy() {
    const element = line.current;
    if (!element) return;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      getSelection()?.selectAllChildren(element);
    }
  }

  return (
    <div className="prompt">
      <p ref={line}>{props.children}</p>
      <button className="outline" type="button" onClick={() => void copy()}>
        {isCopied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
