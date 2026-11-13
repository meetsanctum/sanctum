"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { isEmailAddress } from "../waitlist/join";

type Stage = "asking" | "sending" | "joined";

// What the form says when an address didn't join.
const notes = {
  "not-set-up":
    "The waitlist isn't set up on this copy of the site. Nothing was sent.",
  "too-many": "That's a lot of tries from here. Try again in a few minutes.",
  failed: "That didn't go through. Try again in a moment.",
};

// The waitlist's form. It checks the address itself, so what is wrong shows
// under the field in the page's own words, sends it to the site's own
// route, and answers in the same place.
export function WaitlistForm() {
  const [stage, setStage] = useState<Stage>("asking");
  const [note, setNote] = useState("");
  const [isInvalid, setInvalid] = useState(false);
  const email = useRef<HTMLInputElement>(null);
  const joined = useRef<HTMLParagraphElement>(null);

  // Focus leaves with the form; here a screen reader reads the answer.
  useEffect(() => {
    if (stage === "joined") joined.current?.focus();
  }, [stage]);

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = email.current;
    if (!field) return;
    const address = field.value.trim();
    if (!isEmailAddress(address) || !field.checkValidity()) {
      setInvalid(true);
      setNote("Enter an email address, like name@example.com.");
      field.focus();
      return;
    }
    setInvalid(false);
    setNote("");
    setStage("sending");
    const fields = new FormData(event.currentTarget);
    const answer = await send(address, String(fields.get("company") ?? ""));
    if (answer === "joined") {
      setStage("joined");
      return;
    }
    setStage("asking");
    setNote(notes[answer]);
  }

  if (stage === "joined") {
    return (
      <p className="joined" ref={joined} tabIndex={-1}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
        </svg>
        <span>You're on the list</span>
      </p>
    );
  }

  return (
    <>
      {/* Without JavaScript the form sends nothing, an address least of all
          in the page's own address. */}
      <form
        className="waitlist"
        id="waitlist"
        method="dialog"
        noValidate
        onSubmit={(event) => void join(event)}
      >
        <label className="visually-hidden" htmlFor="email">
          Email address
        </label>
        <input
          ref={email}
          id="email"
          type="email"
          name="email"
          autoComplete="email"
          enterKeyHint="send"
          placeholder="Email address"
          aria-invalid={isInvalid || undefined}
          aria-describedby="waitlist-note"
          required
        />
        {/* A field people never see or reach: a script that fills every
            field fills this one, and the route then keeps nothing. */}
        <input
          className="visually-hidden"
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
        <button
          className="primary"
          type="submit"
          disabled={stage === "sending"}
        >
          Join the waitlist
        </button>
      </form>
      <p className="note" id="waitlist-note" aria-live="polite">
        {note}
      </p>
    </>
  );
}

async function send(
  email: string,
  company: string,
): Promise<"joined" | "not-set-up" | "too-many" | "failed"> {
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, company }),
    });
    if (response.ok) return "joined";
    if (response.status === 503) return "not-set-up";
    return response.status === 429 ? "too-many" : "failed";
  } catch {
    return "failed";
  }
}
