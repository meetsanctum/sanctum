// @vitest-environment jsdom
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectionVeil,
  notAnsweringAfterMs,
  type ConnectionState,
} from "../src/connection-veil";
import type { CoreStatus } from "../src/core-status";
import { goneWithinMs, useGoing, type Going } from "../src/power-notice";
import type { StoredHost } from "../src/shell";

// A restart or shutdown someone asked for on Status: every screen hears of
// it, and its veil says Restarting, Shutting down or Sanctum is off until
// Sanctum is back, or stops waiting if it never went.

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what every screen hears", () => {
  const live = createLiveFeed();
  let seen: Going | undefined;
  function Probe(props: { core: CoreStatus["state"] }) {
    seen = useGoing(live, props.core);
    return null;
  }
  const show = (core: CoreStatus["state"]) =>
    act(async () => root.render(<Probe core={core} />));

  it("holds until Sanctum has gone and answers again", async () => {
    await show("online");
    expect(seen).toBeUndefined();
    await act(async () => live.publish({ type: "system", going: "shutdown" }));
    expect(seen).toEqual({ action: "shutdown", away: false });
    await show("offline");
    expect(seen).toEqual({ action: "shutdown", away: true });
    // A late HTTP acknowledgement must not restart the waiting period.
    await act(async () => live.publish({ type: "system", going: "shutdown" }));
    expect(seen).toEqual({ action: "shutdown", away: true });
    // However long it is off.
    await act(async () => vi.advanceTimersByTimeAsync(10 * goneWithinMs));
    expect(seen?.away).toBe(true);
    await show("online");
    expect(seen).toBeUndefined();
  });

  it("stops waiting for a restart that never happened", async () => {
    await show("online");
    await act(async () => live.publish({ type: "system", going: "restart" }));
    await act(async () => vi.advanceTimersByTimeAsync(goneWithinMs - 1));
    expect(seen?.action).toBe("restart");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(seen).toBeUndefined();
  });
});

describe("the veil", () => {
  const host: StoredHost = {
    hostId: "home-id",
    homeId: "home",
    name: "Maya's home",
    url: "http://192.168.1.20:4100",
    clientId: "c1",
    token: "client_saved",
    kind: "personal",
    pin: null,
  };
  const veil = (state: ConnectionState) =>
    act(async () =>
      root.render(
        <ConnectionVeil state={state} host={host} onForgotten={() => {}} />,
      ),
    );
  const words = () =>
    [...container.querySelectorAll("p")].map((each) => each.textContent);

  it("says it is restarting, and only after a long while that it isn't answering", async () => {
    await veil("restarting");
    expect(words()).toEqual([
      "Restarting",
      "Sanctum is starting again. This takes about 2 minutes, and this screen comes back by itself.",
    ]);
    await act(async () =>
      vi.advanceTimersByTimeAsync(notAnsweringAfterMs.restarting),
    );
    expect(words()[0]).toBe("Your home is not answering");
  });

  it("says how to start it again while it shuts down and once it is off", async () => {
    await veil("shuttingDown");
    expect(words()).toEqual([
      "Shutting down",
      "Sanctum is shutting down. To start it again, unplug its power and plug it back in.",
    ]);
    await veil("off");
    expect(words()).toEqual([
      "Sanctum is off",
      "To start it again, unplug its power and plug it back in. This screen comes back by itself.",
    ]);
    expect(container.querySelector("button")?.textContent).toBe(
      "Choose another home",
    );
    // Off on purpose: never "not answering".
    await act(async () => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(words()[0]).toBe("Sanctum is off");
  });
});
