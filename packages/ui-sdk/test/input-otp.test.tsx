// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InputOTP,
  InputOTPDisplay,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "../src/kit";

// A code typed into boxes: one real input under them, which keeps what the
// filter allows up to the length, fills the boxes in order and says once
// when all are filled.

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Code(props: {
  onComplete?: (value: string) => void;
  filter?: (typed: string) => string;
  invalid?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <InputOTP
      aria-label="Code"
      aria-invalid={props.invalid}
      maxLength={6}
      value={value}
      onChange={setValue}
      onComplete={props.onComplete}
      filter={props.filter}
    >
      <InputOTPGroup>
        {[0, 1, 2].map((index) => (
          <InputOTPSlot key={index} index={index} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {[3, 4, 5].map((index) => (
          <InputOTPSlot key={index} index={index} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

async function render(props: Parameters<typeof Code>[0] = {}) {
  await act(async () => root.render(<Code {...props} />));
  return container.querySelector<HTMLInputElement>("input")!;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function slots() {
  return [...container.querySelectorAll("[data-slot=input-otp-slot]")];
}

describe("a code in boxes", () => {
  it("shows each character in its own box, and is one field to screen readers", async () => {
    const input = await render();
    await type(input, "AB3");

    expect(slots().map((slot) => slot.textContent)).toEqual([
      "A",
      "B",
      "3",
      "",
      "",
      "",
    ]);
    expect(input.getAttribute("aria-label")).toBe("Code");
    for (const slot of slots()) {
      expect(slot.getAttribute("aria-hidden")).toBe("true");
    }
    expect(
      container
        .querySelector("[data-slot=input-otp-separator]")!
        .getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("keeps what the filter allows, up to its length", async () => {
    const input = await render({
      filter: (typed) => typed.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    });

    await type(input, "ab3-de f9z");

    expect(input.hasAttribute("maxlength")).toBe(false);
    expect(input.value).toBe("AB3DEF");
  });

  it("says once when every box is filled, pasted or typed", async () => {
    const onComplete = vi.fn();
    const input = await render({ onComplete });

    await type(input, "ABC12");
    expect(onComplete).not.toHaveBeenCalled();
    await type(input, "ABC123");
    await type(input, "ABC1234");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("ABC123");

    await type(input, "ABC12");
    await type(input, "ABC129");
    expect(onComplete).toHaveBeenLastCalledWith("ABC129");
  });

  it("marks the box the next character goes in while it has focus, with a still caret", async () => {
    const input = await render();
    await type(input, "AB");
    expect(container.querySelector("[data-active]")).toBeNull();

    await act(async () => input.focus());
    await act(async () => {
      input.setSelectionRange(1, 1);
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }),
      );
    });

    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    const active = container.querySelector("[data-active]")!;
    expect(slots().indexOf(active)).toBe(2);
    expect(active.querySelector("span")).not.toBeNull();
    expect(active.className).not.toMatch(/animate/);

    await type(input, "ABCDEF");
    expect(slots().indexOf(container.querySelector("[data-active]")!)).toBe(5);
    expect(container.querySelector("[data-active] span")).toBeNull();
  });

  it("keeps Select All so the full code can be replaced", async () => {
    const input = await render();
    await type(input, "ABC123");
    await act(async () => input.focus());
    await act(async () => {
      input.select();
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "a", bubbles: true }),
      );
    });

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
  });

  it("draws every box as a problem when the field is invalid", async () => {
    await render({ invalid: true });

    expect(
      container
        .querySelector("[data-slot=input-otp]")!
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(container.querySelector("input")!.getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});

describe("a code shown in the boxes", () => {
  const show = (value: string, maxLength = 4) =>
    act(async () =>
      root.render(
        <InputOTPDisplay value={value} maxLength={maxLength}>
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
          </InputOTPGroup>
        </InputOTPDisplay>,
      ),
    );
  const slots = () => [
    ...container.querySelectorAll('[data-slot="input-otp-slot"]'),
  ];

  it("draws each character in its box, with nothing to type in or focus", async () => {
    await show("K7QX");

    const display = container.querySelector('[data-slot="input-otp-display"]')!;
    expect(display.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("input")).toBeNull();
    expect(slots().map((slot) => slot.textContent)).toEqual([
      "K",
      "7",
      "Q",
      "X",
    ]);
    expect(slots().some((slot) => slot.hasAttribute("data-active"))).toBe(
      false,
    );
  });

  it("shows empty boxes, with no caret, while there is no code", async () => {
    await show("");

    expect(slots().map((slot) => slot.textContent)).toEqual(["", "", "", ""]);
    expect(container.querySelector("[data-active]")).toBeNull();
  });

  it("shows characters only up to the display length", async () => {
    await show("K7QX", 3);

    expect(slots().map((slot) => slot.textContent)).toEqual([
      "K",
      "7",
      "Q",
      "",
    ]);
  });

  it("ignores a tab index passed through extra props", async () => {
    const props = { value: "K", maxLength: 1, tabIndex: 0 };
    await act(async () => root.render(<InputOTPDisplay {...props} />));

    const display = container.querySelector('[data-slot="input-otp-display"]')!;
    expect(display.hasAttribute("tabindex")).toBe(false);
  });
});
