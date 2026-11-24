// @vitest-environment jsdom
import type { AiCanUse, AppInfo } from "@meetsanctum/app-sdk";
import type {
  AgentInfo,
  AgentSetupStarted,
  AgentSetupStatus,
} from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsPage } from "../src/agents/agents-page";
import { promptText } from "../src/agents/add-agent";
import { AppCanUseSection } from "../src/agents/app-section";
import { CanUsePage } from "../src/agents/can-use-page";
import { agentDetail, missingWords, turnOnWords } from "../src/agents/words";
import { CoreError, coreJson } from "../src/core-fetch";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const now = new Date("2026-11-22T12:00:00Z");
// Dates and times in this machine's own words, as the page has them.
const day = (at: string) =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
const time = (at: string) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
const codex: AgentInfo = {
  id: "codex",
  name: "Codex on the office Mac",
  platform: "macos",
  addedBy: { kind: "person", id: "maya", name: "Maya" },
  createdAt: "2026-11-20T09:15:00Z",
  lastSeenAt: "2026-11-22T11:59:30Z",
};
const kitchen: AgentInfo = {
  ...codex,
  id: "kitchen",
  name: "Claude Code",
  addedBy: { kind: "client", id: "tablet", name: "Kitchen tablet" },
  lastSeenAt: "2026-11-22T11:35:00Z",
};

const moods = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  icon: null,
  requests: [],
  permissions: [],
  state: "running",
} as unknown as AppInfo;

// An app acting as the household's AI assistant.
const assistant = {
  ...moods,
  id: "sanctum.assistant",
  name: "Assistant",
  requests: [
    {
      id: "ai.assistant",
      reason: "To do what you ask.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
  permissions: ["ai.assistant"],
} as AppInfo;

function canUseWith(changes: Partial<Record<string, boolean>> = {}): AiCanUse {
  const area = (id: string, on: boolean, always = false) => ({
    id,
    on: changes[id] ?? on,
    always,
  });
  const offer = (
    id: string,
    title: string,
    on: boolean,
    kind: "action" | "entity",
    tier: "read" | "write",
    missing: string[] = [],
  ) => ({
    app: moods.id,
    id,
    kind,
    tier,
    title,
    description: "Written for an AI agent.",
    on: changes[id] ?? on,
    needs: missing,
    missing,
  });
  return {
    areas: [
      area("places.read", true, true),
      area("devices.control:light", true),
      area("devices.read:switch", true),
      area("devices.read:motion", false),
      area("people.read", false),
    ],
    offers: [
      offer("example.run", "Run a scene", true, "action", "write"),
      offer("example.create", "Create a scene", false, "action", "write", [
        "devices.control:switch",
      ]),
      offer("example.scene", "Scenes in each room", true, "entity", "read"),
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let agents: AgentInfo[];
let canUse: AiCanUse;
let posted: [string, unknown][];
let setupStatus: AgentSetupStatus;
let refuseSetup: CoreError | undefined;
let setupStart: Promise<AgentSetupStarted> | undefined;
let agentsRead: Promise<AgentInfo[]> | undefined;
let permissionsRead: Promise<AiCanUse> | undefined;
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  agents = [codex, kitchen];
  canUse = canUseWith();
  posted = [];
  setupStatus = { status: "waiting", name: "Codex", expiresAt: "" };
  refuseSetup = undefined;
  setupStart = undefined;
  agentsRead = undefined;
  permissionsRead = undefined;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    if (init.method === "POST") posted.push([path, init.json]);
    switch (path) {
      case "/api/auth/agents":
        return (agentsRead ?? agents) as never;
      case "/api/agents/can-use":
        return (permissionsRead ?? canUse) as never;
      case "/api/agents/can-use/area": {
        const { id, on } = init.json as { id: string; on: boolean };
        canUse = canUseWith({ [id]: on });
        return canUse as never;
      }
      case "/api/agents/can-use/offer": {
        const { id, on } = init.json as { id: string; on: boolean };
        canUse = canUseWith({ [id]: on });
        return canUse as never;
      }
      case "/api/auth/agents/setup":
        if (refuseSetup) throw refuseSetup;
        if (setupStart) return setupStart as never;
        return {
          setupId: `setup-${posted.length}`,
          code: "sanctum:abc",
          expiresAt: "2026-11-22T12:10:00Z",
        } as never;
      case "/api/auth/agents/setup/setup-1":
      case "/api/auth/agents/setup/setup-2":
        return setupStatus as never;
      case "/api/auth/clients/rename":
      case "/api/auth/clients/revoke":
        return undefined as never;
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
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

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
const switchFor = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `[role=switch][aria-label="${name}"]`,
  )!;
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("the words for AI agents", () => {
  it("says who added an agent, when, and when it was last seen", () => {
    const added = day(codex.createdAt);
    expect(agentDetail(codex, [codex], now)).toBe(
      `Added by Maya on ${added} · Seen just now`,
    );
    expect(agentDetail(kitchen, [kitchen], now)).toBe(
      `Added from Kitchen tablet on ${added} · Seen 25 minutes ago`,
    );
    expect(
      agentDetail(
        { ...codex, addedBy: { ...codex.addedBy, name: null } },
        [],
        now,
      ),
    ).toBe(`Added on ${added} · Seen just now`);
  });

  it("tells two agents of the same name apart by when each was added", () => {
    const again = { ...codex, id: "again", createdAt: "2026-11-22T11:40:00Z" };
    expect(agentDetail(codex, [codex, again], now)).toBe(
      `Added by Maya on ${day(codex.createdAt)} at ${time(codex.createdAt)} · Seen just now`,
    );
  });

  it("shows the seconds for agents added with the same name in the same minute", () => {
    const again = { ...codex, id: "again", createdAt: "2026-11-20T09:15:20Z" };
    expect(agentDetail(codex, [codex, again], now)).not.toEqual(
      agentDetail(again, [codex, again], now),
    );
  });

  it("says what an item needs that's off", () => {
    const [, create] = canUseWith().offers;
    expect(missingWords(create!, canUseWith().offers)).toEqual({
      text: "Needs Control your switches, which is off for AI agents",
      area: true,
    });
    const off = canUseWith({ "example.scene": false }).offers;
    expect(
      missingWords(
        { ...create!, missing: ["example.scene", "devices.control:switch"] },
        off,
      ),
    ).toEqual({
      text: "Needs Scenes in each room and Control your switches, which are off for AI agents",
      area: true,
    });
    expect(
      missingWords(
        { ...create!, missing: ["example.scene"] },
        canUseWith().offers,
      )?.area,
    ).toBe(false);
  });

  it("says when an item needs an unavailable offer that is switched on", () => {
    const [, create] = canUseWith().offers;
    expect(
      missingWords(
        { ...create!, missing: ["example.scene"] },
        canUseWith().offers,
      ),
    ).toEqual({
      text: "Needs Scenes in each room, which is unavailable to AI agents",
      area: false,
    });
  });

  it("asks before letting AI agents read what tells who's home", () => {
    expect(turnOnWords("devices.read:motion")).toEqual({
      title: "Let AI agents know when there's motion?",
      description:
        "Motion can show when someone is home. AI agents may share what they read with the company that runs them.",
    });
  });

  it("puts the pinned connector's command in the prompt", () => {
    expect(promptText("sanctum:abc")).toBe(
      "Connect to my Sanctum home. Run `npx -y @meetsanctum/mcp@0.1.0 connect sanctum:abc` and do what it says.",
    );
  });
});

describe("Settings → AI agents", () => {
  let openedCanUse: number;
  let openedApps: string[];

  async function show(apps: AppInfo[] = [moods]) {
    openedCanUse = 0;
    openedApps = [];
    await act(async () =>
      root.render(
        <AgentsPage
          apps={apps}
          live={live}
          onOpenCanUse={() => openedCanUse++}
          onOpenApp={(id) => openedApps.push(id)}
          page={null}
        />,
      ),
    );
  }

  async function menu(name: string, action: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${name}: more"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ].find((candidate) => candidate.textContent === action)!;
    await act(async () => item.click());
  }

  it("says what an agent is before there is one", async () => {
    agents = [];
    await show();
    expect(container.textContent).toContain(
      "Let an AI program on a computer at home",
    );
  });

  it("lists each agent with who added it, and how much AI agents can use", async () => {
    await show();
    expect(container.textContent).toContain("Codex on the office Mac");
    expect(container.textContent).toContain(
      `Added by Maya on ${day(codex.createdAt)}`,
    );
    expect(container.textContent).toContain("Added from Kitchen tablet");
    expect(button("What AI Agents Can Use2 of 4 on")).toBeTruthy();

    await act(async () => button("What AI Agents Can Use2 of 4 on").click());
    expect(openedCanUse).toBe(1);
  });

  it("lists an app acting as the AI assistant, opening its page", async () => {
    await show([moods, assistant]);

    const row = button("AssistantSanctum app")!;
    expect(row).toBeTruthy();
    expect(row.querySelector("[aria-label$='more']")).toBeNull();
    expect(container.textContent).not.toContain("ExampleSanctum app");
    await act(async () => row.click());
    expect(openedApps).toEqual(["sanctum.assistant"]);
  });

  it("keeps a paused assistant app in its place, saying so", async () => {
    agents = [];
    await show([
      { ...assistant, permissions: [], state: "paused" },
      // One that asks for it but hasn't got it isn't one.
      { ...assistant, id: "sanctum.other", name: "Other", permissions: [] },
    ]);

    expect(button("Assistant (paused)Sanctum app")).toBeTruthy();
    expect(container.textContent).not.toContain("Other");
  });

  it("removes an agent and ignores a late poll from before the removal", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await show();
    const poll = deferred<AgentInfo[]>();
    agentsRead = poll.promise;
    await wait(5_000);
    await menu("Codex on the office Mac", "Remove");
    expect(dialog()!.textContent).toContain(
      "a command it already sent may still finish",
    );

    agents = [kitchen];
    agentsRead = undefined;
    await act(async () => button("Remove").click());
    await act(async () => poll.resolve([codex, kitchen]));
    expect(posted).toEqual([["/api/auth/clients/revoke", { id: "codex" }]]);
    expect(container.textContent).not.toContain(codex.name);
  });

  it("renames an agent", async () => {
    await show();
    await menu("Claude Code", "Rename");
    await type(dialog()!.querySelector("input")!, "Claude Code in the kitchen");
    await act(async () => button("Save").click());
    expect(posted).toEqual([
      [
        "/api/auth/clients/rename",
        { id: "kitchen", name: "Claude Code in the kitchen" },
      ],
    ]);
  });

  describe("adding an agent", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    });

    async function add(name: string) {
      await show();
      await act(async () => button("Add an agent").click());
      await type(dialog()!.querySelector("input")!, name);
    }

    it("names what AI agents can use, on and off, before anything is made", async () => {
      await add("Codex");
      const text = dialog()!.textContent!;
      expect(text).toContain("What AI agents can useOn");
      expect(text).toContain(
        "Change any of these in Settings, under What AI Agents Can Use.",
      );
      expect(
        dialog()!.querySelector('[role="region"]')?.getAttribute("aria-label"),
      ).toBe("What AI agents can use");
      expect(text).toContain(
        "OnSee your roomsControl your lightsSee your switches",
      );
      expect(text).toContain("ExampleRun a sceneScenes in each room");
      expect(text).toContain(
        "Off until you switch them onKnow when there's motionSee who lives here",
      );
      expect(text).toContain("ExampleCreate a scene");
      expect(posted).toEqual([]);
    });

    it("requires the permission list to load when the sheet opens", async () => {
      await show();
      const read = deferred<AiCanUse>();
      permissionsRead = read.promise;
      await act(async () => button("Add an agent").click());
      await type(dialog()!.querySelector("input")!, "Codex");
      expect(button("Continue").disabled).toBe(true);
      await act(async () => read.reject(new Error("Connection lost")));
      expect(dialog()!.querySelector("[role=alert]")?.textContent).toContain(
        "What AI agents can use didn't load.",
      );
      expect(button("Continue").disabled).toBe(true);
      expect(posted).toEqual([]);

      await act(async () => button("Cancel").click());
      permissionsRead = undefined;
      canUse = canUseWith({ "devices.control:light": false });
      await act(async () => button("Add an agent").click());
      await type(dialog()!.querySelector("input")!, "Codex");
      expect(dialog()!.textContent).toContain(
        "Off until you switch them onControl your lights",
      );
      expect(button("Continue").disabled).toBe(false);
    });

    it("shows an unmet prerequisite for an offer that is switched on", async () => {
      canUse = canUseWith({ "example.create": true });
      await add("Codex");
      expect(dialog()!.textContent).toContain(
        "Create a sceneNeeds Control your switches, which is off for AI agents.",
      );
    });

    it("keeps a late setup response from replacing a reopened sheet", async () => {
      await add("First");
      const oldStart = deferred<AgentSetupStarted>();
      setupStart = oldStart.promise;
      await act(async () => button("Continue").click());
      await act(async () => button("Cancel").click());
      await act(async () => button("Add an agent").click());
      await type(dialog()!.querySelector("input")!, "Second");

      await act(async () =>
        oldStart.resolve({
          setupId: "setup-1",
          code: "sanctum:old",
          expiresAt: "",
        }),
      );
      expect(dialog()!.querySelector("input")!.value).toBe("Second");
      expect(dialog()!.textContent).not.toContain("sanctum:old");
      setupStart = undefined;
      await act(async () => button("Continue").click());
      expect(dialog()!.textContent).toContain("Connect Second");
    });

    it("shows the prompt, waits, then names the agent once it has connected", async () => {
      await add("Codex");
      await act(async () => button("Continue").click());

      expect(posted).toEqual([["/api/auth/agents/setup", { name: "Codex" }]]);
      expect(dialog()!.textContent).toContain(promptText("sanctum:abc"));
      expect(dialog()!.textContent).toContain("Waiting for Codex to connect");
      expect(button("Copy prompt")).toBeTruthy();

      await wait(1_500);
      expect(dialog()!.textContent).toContain("Waiting for Codex to connect");

      setupStatus = {
        status: "connected",
        agent: { id: "new", name: "Codex" },
        address: "192.168.7.24",
        connectedAt: "2026-11-22T12:01:00Z",
      };
      await wait(1_500);
      expect(dialog()!.textContent).toContain("Codex is connected");
      expect(dialog()!.textContent).toContain("It connected from 192.168.7.24");
      expect(button("Done")).toBeTruthy();
    });

    it("shows the command to run by hand", async () => {
      await add("Codex");
      await act(async () => button("Continue").click());
      await act(async () => button("Set it up by hand").click());

      expect(dialog()!.textContent).toContain(
        "npx -y @meetsanctum/mcp@0.1.0 connect sanctum:abc",
      );
      expect(dialog()!.textContent).not.toContain("Connect to my");
      await act(async () => button("Back").click());
      expect(dialog()!.textContent).toContain("Connect to my Sanctum home");
    });

    it("keeps a late clipboard result from changing the other view", async () => {
      await add("Codex");
      await act(async () => button("Continue").click());
      const copy = deferred<void>();
      const writeText = vi.fn(() => copy.promise);
      vi.stubGlobal("navigator", {
        userAgent: navigator.userAgent,
        clipboard: { writeText },
      });
      await act(async () => button("Copy prompt").click());
      expect(writeText).toHaveBeenCalledWith(promptText("sanctum:abc"));
      await act(async () => button("Set it up by hand").click());
      await act(async () => copy.resolve());
      expect(button("Copy command")).toBeTruthy();
    });

    it("makes a new prompt once one has run out", async () => {
      await add("Codex");
      await act(async () => button("Continue").click());
      setupStatus = { status: "expired", name: "Codex" };
      await wait(1_500);

      expect(dialog()!.textContent).toContain("The prompt has run out");
      expect(dialog()!.textContent).toContain(
        "Codex didn't connect within 10 minutes",
      );
      setupStatus = { status: "waiting", name: "Codex", expiresAt: "" };
      await act(async () => button("Make a new prompt").click());

      expect(posted).toEqual([
        ["/api/auth/agents/setup", { name: "Codex" }],
        ["/api/auth/agents/setup", { name: "Codex" }],
      ]);
      expect(dialog()!.textContent).toContain("Waiting for Codex to connect");
    });

    it("says when too many agents are being added at once", async () => {
      refuseSetup = new CoreError(409, "busy");
      await add("Codex");
      await act(async () => button("Continue").click());
      expect(dialog()!.querySelector("[role=alert]")!.textContent).toContain(
        "Several agents are being added already",
      );
    });
  });
});

describe("What AI agents can use", () => {
  let openedApp: string[];

  async function show() {
    openedApp = [];
    await act(async () =>
      root.render(
        <CanUsePage
          apps={[moods]}
          live={live}
          onOpenApp={(id) => openedApp.push(id)}
          onDone={() => undefined}
        />,
      ),
    );
  }

  it("lists the core's areas, with seeing the rooms always on", async () => {
    await show();
    const home = document.querySelector(
      '[aria-labelledby="settings-ai-home"]',
    )!;
    expect(home.textContent).toContain("See your roomsAI agents need them");
    expect(home.textContent).toContain("Always on");
    expect(switchFor("See your rooms")).toBeNull();
    expect(switchFor("Control your lights").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      document.querySelector('[aria-labelledby="settings-ai-whos-home"]')!
        .textContent,
    ).toContain("Know when there's motion");
  });

  it("switches an area at once", async () => {
    await show();
    await act(async () => switchFor("Control your lights").click());
    expect(posted).toEqual([
      ["/api/agents/can-use/area", { id: "devices.control:light", on: false }],
    ]);
    expect(switchFor("Control your lights").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("refreshes shared permissions and rejects a read older than a local change", async () => {
    await show();
    canUse = canUseWith({ "people.read": true });
    await act(async () => live.refresh());
    expect(switchFor("See who lives here").getAttribute("aria-checked")).toBe(
      "true",
    );

    const read = deferred<AiCanUse>();
    permissionsRead = read.promise;
    await act(async () => live.refresh());
    await act(async () => switchFor("Control your lights").click());
    await act(async () => read.resolve(canUseWith()));
    expect(switchFor("Control your lights").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("asks before an area that tells who's home turns on", async () => {
    await show();
    const motion = switchFor("Know when there's motion");
    await act(async () => motion.click());
    expect(posted).toEqual([]);
    expect(dialog()!.textContent).toContain(
      "Let AI agents know when there's motion?",
    );

    await act(async () => button("Turn on").click());
    expect(posted).toEqual([
      ["/api/agents/can-use/area", { id: "devices.read:motion", on: true }],
    ]);
    expect(document.activeElement).toBe(motion);
  });

  it("returns focus to the switch when the privacy confirmation is cancelled", async () => {
    await show();
    const motion = switchFor("Know when there's motion");
    await act(async () => motion.click());
    await act(async () => button("Cancel").click());
    expect(document.activeElement).toBe(motion);
    expect(posted).toEqual([]);
  });

  it("leads to each app that offers something, with how much is on", async () => {
    await show();
    await act(async () => button("Example2 of 3 on").click());
    expect(openedApp).toEqual([moods.id]);
  });
});

describe("an app's part of what AI agents can use", () => {
  let openedCanUse: number;

  async function show() {
    openedCanUse = 0;
    await act(async () =>
      root.render(
        <AppCanUseSection
          app={moods}
          live={live}
          onOpenCanUse={() => openedCanUse++}
        />,
      ),
    );
  }

  it("shows only once the home has an AI agent", async () => {
    agents = [];
    await show();
    expect(container.textContent).toBe("");
    agents = [codex];
    await act(async () => live.refresh());
    expect(container.textContent).toContain("What AI Agents Can Use");
  });

  it("has what AI agents can do, then what they can know", async () => {
    await show();
    const text = container.textContent!;
    expect(text).toMatch(/^What AI Agents Can Use.*Actions.*Run a scene/);
    expect(text).toMatch(/Information.*Scenes in each room/);
    expect(text).not.toContain("Written for an AI agent");
    expect(text).toContain(
      "AI agents are told what's switched off here, so they can say so.",
    );
  });

  it("says what an item needs, and where to change it", async () => {
    await show();
    expect(container.textContent).toContain(
      "Needs Control your switches, which is off for AI agents.",
    );
    await act(async () => button("Change it in Settings").click());
    expect(openedCanUse).toBe(1);
  });

  it("switches an item at once", async () => {
    await show();
    await act(async () => switchFor("Run a scene").click());
    expect(posted).toEqual([
      [
        "/api/agents/can-use/offer",
        { app: moods.id, id: "example.run", on: false },
      ],
    ]);
    expect(switchFor("Run a scene").getAttribute("aria-checked")).toBe("false");
  });
});
