"use client";

import { useEffect, useRef, useState } from "react";

import { productName } from "../../../../../client/src/brand";

export function LeaveForm(props: { contact: string }) {
  const [stage, setStage] = useState<"asking" | "leaving" | "left">("asking");
  const [note, setNote] = useState("");
  const left = useRef<HTMLHeadingElement>(null);

  // The button is gone once the address is, so what replaced it takes the
  // focus it had.
  useEffect(() => {
    if (stage === "left") left.current?.focus();
  }, [stage]);

  async function leave() {
    setNote("");
    setStage("leaving");
    const answer = await send(props.contact);
    if (answer === "left") {
      setStage("left");
      return;
    }
    setStage("asking");
    setNote(
      answer === "not-set-up"
        ? "The waitlist isn't set up on this copy of the site. Nothing was changed."
        : "That didn't go through. Try again in a moment.",
    );
  }

  if (stage === "left") {
    return (
      <>
        <h1 ref={left} tabIndex={-1}>
          You're off the list
        </h1>
        <p>
          Your address is removed, and you get no more emails from {productName}
          . You can join again any time.
        </p>
        <p>
          <a href="/">Back to {productName}</a>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Leave the waitlist?</h1>
      <p>
        Your address is removed from the {productName} waitlist, and you get no
        more emails.
      </p>
      <button
        className="primary"
        type="button"
        disabled={stage === "leaving"}
        onClick={() => void leave()}
      >
        Leave the waitlist
      </button>
      <p className="note" aria-live="polite">
        {note}
      </p>
    </>
  );
}

async function send(
  contact: string,
): Promise<"left" | "not-set-up" | "failed"> {
  try {
    const response = await fetch(`/api/unsubscribe/${contact}`, {
      method: "POST",
    });
    if (response.ok) return "left";
    return response.status === 503 ? "not-set-up" : "failed";
  } catch {
    return "failed";
  }
}
