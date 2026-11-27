// @vitest-environment jsdom
import type {
  AppInfo,
  DeviceInfo,
  Hearing,
  LiveMessage,
} from "@meetsanctum/app-sdk";
import {
  AppScope,
  type AppClient,
  type LiveListener,
  type PageProps,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ui from "../../src/ui/index";

// The Assistant's page: how speech recognition is getting on, its smart
// speakers by room, opening each in the shell, the home's language, and
// Setup's two steps.

const speaker = (
  id: string,
  name: string,
  roomId: string | null,
  options: { muted?: boolean; offline?: boolean } = {},
): DeviceInfo =>
  ({
    id,
    name,
    roomId,
    availability: options.offline ? "offline" : "online",
    capabilities: [
      {
        id: "audio",
        kind: "audio",
        features: { listens: true, announces: true, mutes: true },
        state: { muted: options.muted ?? false },
      },
    ],
  }) as unknown as DeviceInfo;

const lamp = {
  id: "lamp",
  name: "Desk Lamp",
  roomId: "office",
  availability: "online",
  capabilities: [{ id: "light", kind: "light", features: {}, state: {} }],
} as unknown as DeviceInfo;

function fakeClient(options: {
  hearing: Hearing;
  devices?: DeviceInfo[];
  refuse?: boolean;
}) {
  const app = {
    id: "sanctum.assistant",
    name: "Assistant",
    version: "0.2.0",
    pages: ["main", "setup"],
    permissions: [],
  } as unknown as AppInfo;
  const listeners = new Set<LiveListener>();
  const call = vi.fn(async () => {
    if (options.refuse) throw new Error("refused");
    return {};
  });
  const client = {
    app,
    call,
    hearing: async () => options.hearing,
    devices: async () => options.devices ?? [],
    places: async () => ({
      home: { name: "Home" },
      floors: [],
      rooms: [
        { id: "office", name: "Office", floorId: null },
        { id: "kitchen", name: "Kitchen", floorId: null },
      ],
      zones: [],
    }),
    subscribe: (listener: LiveListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AppClient;
  const push = (message: LiveMessage) =>
    act(() => {
      for (const listener of listeners) listener.message?.(message);
    });
  return { client, call, push };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function pageProps() {
  return {
    params: {},
    open: vi.fn(),
    back: vi.fn(),
    openSettings: vi.fn(),
    openDevice: vi.fn(),
    addDevices: vi.fn(),
  } satisfies PageProps;
}

async function show(client: AppClient, page = "main", props = pageProps()) {
  const Page = ui.pages[page]!;
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Page {...props} />
      </AppScope>,
    );
  });
  return props;
}

const text = () => container.textContent ?? "";
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((each) =>
    each.textContent?.includes(name),
  )!;
const press = (name: string) => act(() => button(name).click());

const office = speaker("office-speaker", "Office Speaker", "office");

describe("the Assistant's page", () => {
  it("says it's ready, with something to try in a speaker's room", async () => {
    const { client } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [office, lamp],
    });
    await show(client);

    expect(text()).toContain("Control your home with your voice");
    expect(text()).toContain("Try “Turn off the Office lights”.");
    expect(text()).toContain("Ready in English");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(text()).toContain("“Turn on the Office lights”");
    expect(text()).toContain(
      "For anything else, it says “I can only help with lights.”",
    );
  });

  it("lists only smart speakers, by room and what stops them, and opens each in the shell", async () => {
    const { client } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [
        office,
        lamp,
        speaker("k", "Kitchen Speaker", null),
        speaker("b", "Bedroom Speaker", "kitchen", { muted: true }),
        speaker("u", "Upstairs Speaker", "office", { offline: true }),
      ],
    });
    const props = await show(client);

    expect(text()).not.toContain("Desk Lamp");
    expect(text()).toContain("Office SpeakerOffice");
    expect(text()).toContain(
      "Kitchen SpeakerNo room · say the room when you ask",
    );
    expect(text()).toContain(
      "Bedroom SpeakerKitchen · Microphones off · turn them on from its page",
    );
    expect(text()).toContain(
      "Upstairs SpeakerOffice · Not responding · check its power",
    );

    await press("Office Speaker");
    expect(props.openDevice).toHaveBeenCalledWith("office-speaker");
    await press("Add a smart speaker");
    expect(props.addDevices).toHaveBeenCalledOnce();
  });

  it("asks for a smart speaker when there's none, with no list of them", async () => {
    const { client } = fakeClient({
      hearing: { state: "no_speaker", language: "en" },
      devices: [lamp],
    });
    const props = await show(client);

    expect(text()).toContain("No smart speaker yet");
    expect(text()).not.toContain("Smart speakers");
    expect(button("Add a smart speaker").dataset.variant).toBe("default");
    await press("Add a smart speaker");
    expect(props.addDevices).toHaveBeenCalledOnce();
  });

  it("names each step while it gets ready, and follows it live", async () => {
    const { client, push } = fakeClient({
      hearing: { state: "downloading", language: "en" },
      devices: [office],
    });
    await show(client);

    expect(text()).toContain("Getting ready to listen");
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-label"),
    ).toBe("Downloading speech recognition for English");

    push({ type: "hearing", hearing: { state: "learning", language: "en" } });
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-label"),
    ).toBe("Learning your rooms and lights");

    push({ type: "hearing", hearing: { state: "ready", language: "en" } });
    expect(text()).toContain("Ready in English");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("says why it can't listen, with settings when it's off", async () => {
    const { client } = fakeClient({
      hearing: { state: "failed", language: "en", failure: "assistant_off" },
      devices: [office],
    });
    const props = await show(client);

    expect(text()).toContain("The Assistant is off");
    await press("Open settings");
    expect(props.openSettings).toHaveBeenCalledOnce();

    const memory = fakeClient({
      hearing: { state: "failed", language: "en", failure: "memory" },
      devices: [office],
    });
    await show(memory.client);
    expect(text()).toContain("Not enough memory for speech recognition");
    expect(button("Open settings")).toBeUndefined();
  });

  it("switches the language, saying the old one keeps working", async () => {
    const { client, call, push } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [office],
    });
    await show(client);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "de";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(call).toHaveBeenCalledWith("assistant.language", { language: "de" });

    push({
      type: "hearing",
      hearing: { state: "downloading", language: "de" },
    });
    expect(text()).toContain("Switching to Deutsch");
    expect(text()).toContain("English keeps working until then.");
    expect(text()).toContain("“Mach das Licht aus”");

    push({ type: "hearing", hearing: { state: "ready", language: "de" } });
    expect(text()).toContain("Ready in Deutsch");
  });

  it("says when the language didn't change", async () => {
    const { client } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [office],
      refuse: true,
    });
    await show(client);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "de";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(text()).toContain("The language didn't change.");
  });

  it("opens Setup", async () => {
    const { client } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [office],
    });
    const props = await show(client);

    await press("Set up step by step");
    expect(props.open).toHaveBeenCalledWith("setup");
  });
});

describe("Setup", () => {
  it("chooses the language, then shows what to try with the speakers", async () => {
    const { client, call } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [office],
    });
    const props = await show(client, "setup");

    expect(text()).toContain("Step 1 of 2");
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "de";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(text()).toContain("“Mach das Licht aus”");
    expect(call).not.toHaveBeenCalled();

    await press("Continue");
    expect(call).toHaveBeenCalledWith("assistant.language", { language: "de" });
    expect(text()).toContain("Step 2 of 2");
    expect(text()).toContain("Office Speaker");

    await press("Done");
    expect(props.back).toHaveBeenCalledOnce();
  });

  it("goes back to the page on Cancel, and keeps a language it already has", async () => {
    const { client, call } = fakeClient({
      hearing: { state: "ready", language: "en" },
      devices: [],
    });
    const props = await show(client, "setup");

    await press("Continue");
    expect(call).not.toHaveBeenCalled();
    expect(text()).toContain("Try it");
    expect(text()).toContain("No smart speaker yet");

    await press("Back");
    await press("Cancel");
    expect(props.back).toHaveBeenCalledOnce();
  });
});
