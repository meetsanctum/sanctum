// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { TemperatureUnitProvider } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attentionTile } from "../src/attention";
import { coreJson } from "../src/core-fetch";
import { StatusPage, StatusRow } from "../src/settings-status";
import {
  fineText,
  formatBytes,
  formatMemory,
  problemFix,
  problemTitle,
  runningFor,
  signalWord,
  type HostProblem,
  type SystemStatus,
  type MemoryPart,
} from "../src/system-status";
import { piStatus, statusApps } from "./system-status-fixtures";

// Settings → Status: the verdict first, then Sanctum with its processor and
// power supply, its storage and memory with what fills them, what each reading
// of the last 24 hours reads now and the network, from GET /api/system/status
// every 5 seconds.

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
let answer: () => Promise<SystemStatus>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  answer = async () => piStatus();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/system/status") return answer();
    throw new Error(`Unexpected request: ${path}`);
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

async function render(
  unit: "celsius" | "fahrenheit" = "celsius",
  apps: AppInfo[] = statusApps,
) {
  await act(async () => {
    root.render(
      <TemperatureUnitProvider unit={unit}>
        <StatusPage apps={apps} onDone={() => {}} />
      </TemperatureUnitProvider>,
    );
  });
}

const section = (id: string) =>
  container.querySelector(`section[aria-labelledby="${id}"]`);

// Each part's name and size, as its row reads.
const parts = (id: string) =>
  [...(section(id)?.querySelectorAll("ul > li") ?? [])].map((row) => {
    const [name, line] = [
      ...row.querySelectorAll(":scope > span:nth-child(2) > span"),
    ].map((span) => span.textContent);
    const size = row.querySelector(":scope > span:last-child")?.textContent;
    return [name, line ?? null, size];
  });

// Each reading's name and what it reads now, as its heading says.
const readings = (id: string) =>
  [...(section(id)?.querySelectorAll("h3") ?? [])].map((name) => [
    name.textContent,
    name.nextElementSibling?.textContent ?? null,
  ]);

const facts = (id: string) =>
  [...(section(id)?.querySelectorAll("dl > div") ?? [])].map((fact) => [
    fact.querySelector("dt")?.textContent,
    fact.querySelector("dd")?.textContent,
  ]);

describe("the Status page", () => {
  it("leads with a green check while everything's running, then what Sanctum is", async () => {
    await render();

    const sanctum = section("status-sanctum")!;
    const verdict = sanctum.querySelector('[role="status"]')!;
    expect(verdict.textContent).toBe(
      "Everything's runningStorage, memory, temperature and power are fine",
    );
    expect(verdict.querySelector("span.text-green")?.textContent).toBe(
      "Everything's running",
    );
    expect(facts("status-sanctum")).toEqual([
      ["Model", "Raspberry Pi 4 Model B, 8 GB"],
      ["Processor", "4 cores at 1.8 GHz"],
      ["Power supply", "Enough power"],
      ["Version", "dev-ed4f70b · Dev channel"],
      ["Operating system", "Debian 13 (trixie), 64-bit"],
      ["Running for", "4 days, 21 hours"],
    ]);
  });

  it("says what takes the space: Sanctum's parts by size, each app with its icon, the system last", async () => {
    await render();

    expect(section("status-storage")?.textContent).toContain(
      "Storage6.92 GB free of 15.1 GB",
    );
    expect(parts("status-storage")).toEqual([
      ["Dev builds", "Builds to update to, on the dev channel", "1.35 GB"],
      ["Software", "This version and the one before, to go back to", "1.21 GB"],
      [
        "Home's data",
        "Backups 17.4 MB · devices, history and activity 11.3 MB",
        "28.7 MB",
      ],
      ["Zigbee", null, "330 KB"],
      ["Moods", null, "180 KB"],
      ["System and other", "Debian, its swap space and logs", "5.57 GB"],
    ]);
    const bar = section("status-storage")!.querySelector('[role="img"]')!;
    expect(bar.getAttribute("aria-label")).toBe(
      "Storage, 6.92 GB free of 15.1 GB: Dev builds 1.35 GB, Software 1.21 GB, Home's data 28.7 MB, Zigbee 330 KB, Moods 180 KB, System and other 5.57 GB",
    );
    // In the brand's colours, apps in their own; the free space is the track.
    expect(
      [...bar.querySelectorAll("span")].map((span) =>
        span.className.split(" ").find((name) => name.startsWith("bg-")),
      ),
    ).toEqual([
      "bg-pink",
      "bg-purple",
      "bg-green",
      "bg-gray",
      "bg-orange",
      "bg-foreground/24",
      "bg-foreground/8",
    ]);
  });

  it("says what holds the memory, the system last", async () => {
    await render();

    expect(section("status-memory")?.textContent).toContain(
      "Memory7.02 GB free of 7.64 GB",
    );
    expect(parts("status-memory")).toEqual([
      ["Sanctum", "Moods and Zigbee run inside it", "164 MB"],
      ["Zigbee", "Talks to your Zigbee devices, for the Zigbee app", "132 MB"],
      [
        "Updates and services",
        "Keeps Sanctum running and up to date",
        "104 MB",
      ],
      ["Dev builds", "Takes the builds pushed to update to", "43.7 MB"],
      ["Messaging", "Carries messages between Zigbee and Sanctum", "7.82 MB"],
      ["System and other", "Debian and what it runs", "175 MB"],
    ]);
  });

  describe("with apps that have their own part", () => {
    const apart = (app: AppInfo): AppInfo => ({
      ...app,
      run: { since: "2026-11-06T10:00:00.000Z" },
    });
    const weather: AppInfo = {
      ...statusApps[0]!,
      id: "sanctum.weather",
      name: "Weather",
      icon: { glyph: "cloud-sun", color: "sky" },
    };
    const [moods, zigbee] = statusApps as [AppInfo, AppInfo];
    const mebibyte = 1024 * 1024;

    const showMemory = (memory: MemoryPart[], apps: AppInfo[]) => {
      const status = piStatus();
      answer = async () => ({
        ...status,
        host: {
          ...status.host!,
          memory: { ...status.host!.memory!, parts: memory },
        },
      });
      return render("celsius", apps);
    };

    const everything: MemoryPart[] = [
      { kind: "core", bytes: 148 * mebibyte },
      { kind: "manager", bytes: 71 * mebibyte },
      { kind: "devBuilds", bytes: 18 * mebibyte },
      {
        kind: "app",
        app: "sanctum.weather",
        bytes: 34 * mebibyte,
        services: [],
      },
      {
        kind: "app",
        app: "sanctum.zigbee",
        bytes: 236 * mebibyte,
        services: ["mosquitto", "zigbee2mqtt"],
      },
      { kind: "system", bytes: 312 * mebibyte },
    ];

    it("lists Sanctum's own first, then each app by size, and the system last", async () => {
      await showMemory(everything, [moods, zigbee, apart(weather)]);

      expect(parts("status-memory")).toEqual([
        ["Sanctum", "Moods and Zigbee run inside it", "148 MB"],
        [
          "Updates and services",
          "Keeps Sanctum running and up to date",
          "71 MB",
        ],
        ["Dev builds", "Takes the builds pushed to update to", "18 MB"],
        ["Zigbee", "With messaging and Zigbee2MQTT, which it uses", "236 MB"],
        ["Weather", null, "34 MB"],
        ["System and other", "Debian and what it runs", "312 MB"],
      ]);
    });

    it("draws each app in its own colour, and Updates and services in green", async () => {
      await showMemory(everything, [moods, zigbee, apart(weather)]);

      const bar = section("status-memory")!.querySelector('[role="img"]')!;
      expect(
        [...bar.querySelectorAll("span")].map((span) =>
          span.className.split(" ").find((name) => name.startsWith("bg-")),
        ),
      ).toEqual([
        "bg-purple",
        "bg-green",
        "bg-pink",
        "bg-gray",
        "bg-cyan",
        "bg-foreground/24",
        "bg-foreground/8",
      ]);
    });

    it("shows each app's icon, as Storage does", async () => {
      await showMemory(everything, [moods, zigbee, apart(weather)]);

      const rows = [...section("status-memory")!.querySelectorAll("ul > li")];
      const weatherRow = rows.find((row) =>
        row.textContent?.startsWith("Weather"),
      )!;
      expect(weatherRow.querySelector("img, svg")).not.toBeNull();
    });

    it("says it of one app still inside Sanctum", async () => {
      await showMemory(everything, [moods, apart(zigbee), apart(weather)]);

      expect(parts("status-memory")[0]).toEqual([
        "Sanctum",
        "Moods runs inside it",
        "148 MB",
      ]);
    });

    it("says it's on its own once none are", async () => {
      await showMemory(everything, [
        apart(moods),
        apart(zigbee),
        apart(weather),
      ]);

      expect(parts("status-memory")[0]).toEqual([
        "Sanctum",
        "On its own; each app has its own part",
        "148 MB",
      ]);
    });
  });

  it("says how busy and warm it is now, and how it reaches the network", async () => {
    await render("fahrenheit");

    // Over the last 24 hours, which this page can't read.
    expect(readings("status-day")).toEqual([
      ["Processor", "3% now"],
      ["Temperature", "136°F now · normal"],
      ["Memory in use", "627 MB now"],
    ]);
    expect(facts("status-network")).toEqual([
      ["Connection", "Wi-Fi · signal excellent"],
      ["Name on the network", "sanctum-dev.local"],
      ["IP address", "192.168.3.222"],
      ["Clock", "Synchronised"],
    ]);
  });

  it("does not report a disconnection when the network reading is unavailable", async () => {
    const status = piStatus();
    status.host!.network = null;
    answer = async () => status;
    await render();

    expect(facts("status-network")).toEqual([
      ["Name on the network", "sanctum-dev.local"],
      ["Clock", "Synchronised"],
    ]);
  });

  it("lists each problem in red with what to do, the most pressing first", async () => {
    const status = piStatus();
    status.host!.storage!.free = 800_000_000;
    status.host!.processor.celsius = 83;
    status.problems = [
      { kind: "storage", free: 800_000_000 },
      { kind: "heat", celsius: 83 },
    ];
    answer = async () => status;
    await render();

    const verdict =
      section("status-sanctum")!.querySelector('[role="status"]')!;
    expect(
      [...verdict.querySelectorAll("li")].map((row) => row.textContent),
    ).toEqual([
      "Storage almost full, 800 MB freeAn update needs 1.5 GB free: move Sanctum to a larger card or drive",
      "Too hot, 83°CIt has slowed down to cool off. Give it room to breathe, or a case with a fan",
    ]);
    expect(verdict.querySelectorAll("span.text-destructive").length).toBe(2);
    const hint = section("status-storage")!.querySelector("h2 + span")!;
    expect(hint.className).toContain("text-destructive");
    expect(readings("status-day")[1]).toEqual([
      "Temperature",
      "83°C now · too hot",
    ]);
    expect(
      section("status-day")!.querySelectorAll("h3")[1]!.nextElementSibling!
        .className,
    ).toContain("text-destructive");
  });

  it("says in red when the power supply is too weak", async () => {
    const status = piStatus();
    status.host!.power = { low: true, lastLowAt: status.checkedAt };
    status.problems = [{ kind: "power", lastLowAt: status.checkedAt }];
    answer = async () => status;
    await render();

    const power = [
      ...section("status-sanctum")!.querySelectorAll("dl > div > dd"),
    ][2]!;
    expect(power.textContent).toBe("Too weak right now");
    expect(power.className).toContain("text-destructive");
  });

  it("says what Sanctum itself knows while its updates and services don't answer", async () => {
    answer = async () => piStatus({ channel: null, host: null, problems: [] });
    await render();

    expect(section("status-sanctum")?.textContent).toBe(
      "SanctumCan't check right nowUpdates and services isn't answering. It's usually back within a minute, and this fills in by itselfVersiondev-ed4f70b",
    );
    expect(section("status-storage")).toBeNull();
  });

  it("shows the rows' shapes at once, then asks again every 5 seconds", async () => {
    let release: (status: SystemStatus) => void = () => {};
    answer = () => new Promise((resolve) => (release = resolve));
    await render();
    vi.useFakeTimers();

    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(2);

    await act(async () => release(piStatus()));
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    const asked = () =>
      vi
        .mocked(coreJson)
        .mock.calls.filter(([path]) => path === "/api/system/status").length;
    expect(asked()).toBe(1);

    answer = async () => piStatus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(asked()).toBe(2);
  });

  it("reports an initial request failure and recovers on the next poll", async () => {
    vi.useFakeTimers();
    answer = async () => {
      throw new Error("unavailable");
    };
    await render();

    expect(container.textContent).toContain("Can't check right now");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    answer = async () => piStatus();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toContain("Everything's running");
    expect(section("status-storage")).not.toBeNull();
  });

  it("does not present a previous healthy reading as current after a failed poll", async () => {
    vi.useFakeTimers();
    await render();
    answer = async () => {
      throw new Error("unavailable");
    };
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(container.textContent).toContain("Can't check right now");
    expect(container.textContent).not.toContain("Everything's running");
    expect(section("status-storage")).toBeNull();

    await act(async () =>
      root.render(<StatusRow status={piStatus()} failed onOpen={() => {}} />),
    );
    const row = container.querySelector("button")!;
    expect(row.textContent).toContain("Can't check right now");
    expect(row.getAttribute("aria-label")).toContain("can't check right now");
  });

  it("says Checking on System's row, to a screen reader too, while the first answer is on its way", async () => {
    await act(async () =>
      root.render(
        <StatusRow status={undefined} failed={false} onOpen={() => {}} />,
      ),
    );

    const row = container.querySelector("button")!;
    expect(row.textContent).toBe("StatusChecking…");
    expect(row.getAttribute("aria-label")).toBe(
      "Status: checking. Opens Status",
    );
  });
});

describe("the words", () => {
  it("sizes storage in decimal units and memory in binary ones, to three places", () => {
    expect(formatBytes(1_349_000_000)).toBe("1.35 GB");
    expect(formatBytes(15_072_243_712)).toBe("15.1 GB");
    expect(formatBytes(52_000)).toBe("52 KB");
    expect(formatBytes(300)).toBe("under 1 KB");
    expect(formatMemory(171_470_848)).toBe("164 MB");
    expect(formatMemory(8_199_577_600)).toBe("7.64 GB");
  });

  it("says how long it has run, and how good its signal is", () => {
    expect(runningFor(421_763)).toBe("4 days, 21 hours");
    expect(runningFor(7_920)).toBe("2 hours, 12 minutes");
    expect(runningFor(86_400)).toBe("1 day");
    expect(runningFor(20)).toBe("1 minute");
    expect([-37, -55, -65, -80].map(signalWord)).toEqual([
      "excellent",
      "good",
      "fair",
      "weak",
    ]);
  });

  it("names only what it could check as fine", () => {
    const { host } = piStatus();
    expect(fineText({ ...host!, power: null })).toBe(
      "Storage, memory and temperature are fine",
    );
  });

  it("says when an app's data is missing or damaged", () => {
    const appName = (id: string) => (id === "sanctum.moods" ? "Moods" : id);
    const missing: HostProblem = {
      kind: "appData",
      app: "sanctum.moods",
      state: "missing",
    };

    expect(problemTitle(missing, "celsius")).toBe("An app's data is missing");
    expect(problemFix(missing, appName)).toBe(
      "Moods can't start until its data is back",
    );
    expect(problemTitle({ ...missing, state: "damaged" }, "celsius")).toBe(
      "An app's data is damaged",
    );
  });

  it("says when memory limits are off and what that means", () => {
    const problem: HostProblem = { kind: "memoryLimits" };

    expect(problemTitle(problem, "celsius")).toBe("Memory limits are off");
    expect(problemFix(problem, (id) => id)).toBe(
      "An app can use more memory than it should until they're on in Sanctum's boot settings",
    );
  });

  it("says each problem and what to do, in the home's words", () => {
    const appName = (id: string) => (id === "sanctum.zigbee" ? "Zigbee" : id);
    const now = new Date("2026-11-02T19:41:00Z");
    const words = (problem: HostProblem) => [
      problemTitle(problem, "celsius"),
      problemFix(problem, appName, now),
    ];
    const zigbee = (problem: string, state: "failed" | "waiting" = "waiting") =>
      words({
        kind: "service",
        service: "zigbee2mqtt",
        state,
        problem,
        apps: ["sanctum.zigbee"],
      });

    expect(words({ kind: "power", lastLowAt: "2026-11-02T18:40:00Z" })).toEqual(
      [
        "Power supply too weak",
        `Use the official one: too little power can damage Sanctum's data. Last at ${new Date("2026-11-02T18:40:00Z").toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
      ],
    );
    expect(
      words({ kind: "memory", available: 90_000_000, total: 1_900_000_000 }),
    ).toEqual([
      "Short of memory",
      "It's using its storage as memory, so Sanctum may be slow",
    ]);
    expect(zigbee("No Zigbee coordinator is plugged in")).toEqual([
      "Zigbee isn't running",
      "No Zigbee adapter is plugged in. Plug it in, and Zigbee starts by itself",
    ]);
    expect(
      zigbee(
        "The Zigbee coordinator /dev/serial/by-id/usb-x is not plugged in",
      )[1],
    ).toBe(
      "The Zigbee adapter it uses isn't plugged in. Plug it in again, and Zigbee starts by itself",
    );
    expect(
      zigbee("Choose the adapter type of the Zigbee coordinator /dev/x")[1],
    ).toBe("Open Zigbee to choose its adapter");
    expect(zigbee("It is exited", "failed")).toEqual([
      "Zigbee stopped",
      "Sanctum starts it again by itself",
    ]);
  });
});

describe("the dashboard's Attention tile", () => {
  const power: HostProblem = {
    kind: "power",
    lastLowAt: "2026-11-02T18:40:00Z",
  };

  it("names Sanctum and its problem, and opens Status, while only Sanctum needs someone", () => {
    expect(attentionTile([], [power])).toEqual({
      title: "Sanctum",
      value: "Power too weak",
      label: "Sanctum: Power supply too weak",
      problem: true,
      opens: "status",
    });
  });

  it("counts Sanctum with the devices, and opens Settings", () => {
    const device = {
      id: "lamp",
      name: "Office lamp",
      availability: "offline",
      roomId: "office",
      leftAt: null,
    } as unknown as Parameters<typeof attentionTile>[0][number]["device"];

    expect(
      attentionTile([{ device, reasons: ["offline"] }], [power]),
    ).toMatchObject({
      title: "Attention",
      value: "Sanctum, 1 device",
      label:
        "Attention, Sanctum, 1 device: Sanctum: Power supply too weak, Office lamp is offline",
      opens: "settings",
    });
  });

  const moods = {
    id: "sanctum.moods",
    name: "Moods",
    permissions: [],
    requests: [
      {
        id: "devices.control:light",
        reason: "To set them.",
        needed: true,
        asked: null,
        startsOn: false,
      },
    ],
    state: "paused",
  } as unknown as AppInfo;

  it("names an app that isn't running, red only once it stopped", () => {
    expect(attentionTile([], [], "celsius", [moods])).toEqual({
      title: "Moods",
      value: "Paused",
      label: "Moods is paused",
      problem: false,
      opens: "settings",
    });
    expect(
      attentionTile([], [], "celsius", [{ ...moods, state: "stopped" }]),
    ).toMatchObject({ value: "Not running", problem: true });
  });

  it("counts apps with Sanctum and the devices", () => {
    const weather = { ...moods, id: "sanctum.weather", name: "Weather" };
    expect(attentionTile([], [power], "celsius", [moods])).toMatchObject({
      title: "Attention",
      value: "Sanctum, Moods",
    });
    expect(attentionTile([], [], "celsius", [moods, weather])).toMatchObject({
      title: "Attention",
      value: "2 apps",
      label: "Attention, 2 apps: Moods is paused, Weather is paused",
    });
  });
});
