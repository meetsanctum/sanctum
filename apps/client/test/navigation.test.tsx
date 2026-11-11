// @vitest-environment jsdom
import type { DashboardInfo } from "@meetsanctum/app-sdk";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppsPage, type ListedApp } from "../src/apps-page";
import { dashboardBackground, dashboardFrame } from "../src/dashboards";
import { ShellFrame } from "../src/shell-frame";
import { SidebarContent } from "../src/sidebar";
import { SidebarPins, type PinnedApp } from "../src/sidebar-pins";
import { useSidebarLayout } from "../src/sidebar-state";
import { TopBar } from "../src/top-bar";
import type { Account } from "../src/user-menu";

const opened: string[] = [];
const apps: ListedApp[] = [
  {
    id: "sanctum.moods",
    name: "Moods",
    icon: { glyph: "sparkles", color: "ember" },
    onOpen: () => opened.push("sanctum.moods"),
  },
  {
    id: "sanctum.example",
    name: "Example",
    icon: { glyph: "list-checks", color: "sky" },
    onOpen: () => opened.push("sanctum.example"),
  },
];

const home: DashboardInfo = {
  id: "home",
  name: "Home",
  background: "mocha",
  kind: "home",
  devices: [],
};
const night: DashboardInfo = {
  id: "night",
  name: "Night",
  background: "mocha",
  kind: "custom",
};
const renamed: { id: string; name: string }[] = [];
let rename = async (id: string, name: string) => {
  renamed.push({ id, name });
};

function Navigation({
  onDashboard = true,
  pinned = [],
  isLoading = false,
  isVeiled = false,
  account,
}: {
  onDashboard?: boolean;
  pinned?: PinnedApp[];
  /** The household's pins are not read yet. */
  isLoading?: boolean;
  isVeiled?: boolean;
  account?: Account;
}) {
  const sidebar = useSidebarLayout(isVeiled);
  const [editing, setEditing] = useState(false);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  return (
    <ShellFrame
      screenRef={() => {}}
      layout={sidebar}
      isPlace={onDashboard}
      place={dashboardFrame.mocha}
      deviceMode="evening"
      panelBackground={undefined}
      isVeiled={isVeiled}
      triggerRef={sidebarTrigger}
      sidebar={(isFloating) => (
        <SidebarContent
          isInert={isVeiled || (!isFloating && !sidebar.docked)}
          account={account}
          toggle={
            isFloating
              ? {
                  label: sidebar.canDock
                    ? "Keep the sidebar shown"
                    : "Hide the sidebar",
                  onClick: sidebar.keepShown,
                }
              : undefined
          }
          pins={
            <SidebarPins
              apps={isLoading ? undefined : pinned}
              appsCurrent={false}
              openApps={() => opened.push("apps")}
              pinApps={() => opened.push("pin apps")}
            />
          }
          dashboards={[home, night].map((dashboard) => ({
            ...dashboard,
            background: dashboardBackground[dashboard.background],
            home: dashboard.kind === "home",
            current: onDashboard && dashboard.id === home.id,
            onSelect: sidebar.close,
          }))}
        />
      )}
      panel={
        <TopBar
          sidebarTrigger={sidebarTrigger}
          sidebarShown={sidebar.docked || sidebar.floating !== null}
          sidebarDocked={sidebar.docked}
          onSidebar={sidebar.toggle}
          dashboard={onDashboard ? home : undefined}
          onRename={(id, name) => rename(id, name)}
          onEditHome={{ disabled: false, open: () => setEditing(true) }}
          editingHome={
            editing ? { onDone: () => setEditing(false) } : undefined
          }
        />
      }
    />
  );
}

// The window's width and its pointer, as media queries answer them; jsdom
// has none, which the shell takes as a wide window with no hover.
function windowIs(options: { wide: boolean; hovers: boolean }) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width")
      ? options.wide
      : query.includes("hover")
        ? options.hovers
        : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

let root: Root;
let container: HTMLDivElement;
async function render(element = <Navigation />) {
  await act(async () => {
    root.render(element);
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  opened.length = 0;
  renamed.length = 0;
  rename = async (id, name) => {
    renamed.push({ id, name });
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const docked = () =>
  container.querySelector(".home-screen")!.getAttribute("data-sidebar");

describe("the frame's backing under the glass", () => {
  const backing = () =>
    container.querySelector<HTMLElement>(".frame-under-glass")!;

  it("is the place's deepened colour beside a place", () => {
    expect(backing().getAttribute("style")).toContain("--dashboard-mocha-deep");
  });

  it("is the mode's card fill beside an app's page", async () => {
    await render(<Navigation onDashboard={false} />);

    expect(backing().getAttribute("style") ?? "").not.toContain("--dashboard");
    expect(backing().dataset.mode).toBe("evening");
  });
});

describe("the top bar", () => {
  const labels = () =>
    [...container.querySelectorAll("header button")].map((each) =>
      each.getAttribute("aria-label"),
    );

  it("starts with the sidebar's toggle, names the dashboard on show, with its menu, and has no Back or Apps", async () => {
    const bar = container.querySelector("header")!;
    expect(bar.textContent).toBe("Home");
    expect(labels()).toEqual(["Hide the sidebar", "Home: more"]);
    await render(<Navigation onDashboard={false} />);
    expect(bar.textContent).toBe("");
    expect(labels()).toEqual(["Hide the sidebar"]);
  });

  it("has buttons all of one kind, Button's ghost in the bar's size", () => {
    for (const label of ["Hide the sidebar", "Home: more"]) {
      expect(button(label).dataset).toMatchObject({
        variant: "ghost",
        size: "bar",
      });
    }
  });
});

describe("the dashboard's menu", () => {
  // Sets an input's value the way typing does, so React sees it.
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
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === name,
    )!;

  async function openMenu() {
    await act(async () =>
      container
        .querySelector('button[aria-label="Home: more"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
    );
    return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
  }

  async function startRenaming() {
    const items = await openMenu();
    await act(async () =>
      items.find((item) => item.textContent === "Rename")!.click(),
    );
    return document.querySelector<HTMLElement>("[role=dialog]")!;
  }

  it("holds Edit Home and Rename for Home, and no Delete", async () => {
    expect((await openMenu()).map((item) => item.textContent)).toEqual([
      "Edit Home",
      "Rename",
    ]);
  });

  it("opens Edit Home, named in the top bar until Done", async () => {
    const items = await openMenu();
    await act(async () => items[0]!.click());

    const bar = container.querySelector("header")!;
    expect(bar.textContent).toBe("Edit HomeDone");
    expect(
      container.querySelector('button[aria-label="Home: more"]'),
    ).toBeNull();

    await act(async () => button("Done").click());
    expect(bar.textContent).toBe("Home");
    expect(
      container.querySelector('button[aria-label="Home: more"]'),
    ).not.toBeNull();
  });

  it("renames the dashboard from a dialog with its name", async () => {
    const dialog = await startRenaming();
    expect(dialog.querySelector("h2")?.textContent).toBe(
      "Rename this dashboard",
    );
    const name = dialog.querySelector("input")!;
    expect(name.value).toBe("Home");

    await type(name, "  Living room ");
    await act(async () => button("Save").click());

    expect(renamed).toEqual([{ id: "home", name: "Living room" }]);
    await vi.waitFor(() =>
      expect(document.querySelector("[role=dialog]")).toBeNull(),
    );
    // Radix hands focus back on a timer once the dialog has unmounted.
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Home: more",
      ),
    );
  });

  it("closes without a write when the name is the same", async () => {
    await startRenaming();
    await act(async () => button("Save").click());

    expect(renamed).toEqual([]);
    await vi.waitFor(() =>
      expect(document.querySelector("[role=dialog]")).toBeNull(),
    );
  });

  it("needs a name", async () => {
    const dialog = await startRenaming();
    await type(dialog.querySelector("input")!, "   ");
    expect(button("Save").disabled).toBe(true);
  });

  it("stays open and says so when the rename does not work", async () => {
    rename = () => Promise.reject(new Error("not_found"));
    const dialog = await startRenaming();
    await type(dialog.querySelector("input")!, "Living room");
    await act(async () => button("Save").click());

    expect(dialog.querySelector("[role=alert]")?.textContent).toBe(
      "That did not work. Try again.",
    );
    expect(button("Save").disabled).toBe(false);
  });

  it("ignores a rename that finishes after Cancel", async () => {
    let finish!: () => void;
    rename = () => new Promise<void>((resolve) => (finish = resolve));
    const dialog = await startRenaming();
    await type(dialog.querySelector("input")!, "Living room");
    await act(async () => button("Save").click());
    await act(async () => button("Cancel").click());
    await vi.waitFor(() =>
      expect(document.querySelector("[role=dialog]")).toBeNull(),
    );

    const reopened = await startRenaming();
    await act(async () => finish());

    expect(document.querySelector("[role=dialog]")).toBe(reopened);
    expect(reopened.querySelector("input")!.value).toBe("Home");
    expect(button("Save").disabled).toBe(false);
  });
});

describe("the sidebar", () => {
  it.each(["connection veil", "collapsed sidebar"])(
    "closes the docked account menu under a %s",
    async (state) => {
      const account: Account = {
        person: { id: "maya", name: "Maya", colour: "#ff9500", avatar: null },
        onSettings() {},
        onSignOut() {},
      };
      await render(<Navigation account={account} />);
      await act(async () =>
        button("Maya's menu").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      expect(document.querySelector("[role=menu]")).not.toBeNull();

      if (state === "connection veil") {
        await render(<Navigation account={account} isVeiled />);
      } else {
        await act(async () => button("Hide the sidebar").click());
      }

      expect(document.querySelector("[role=menu]")).toBeNull();
      expect(container.querySelector("aside")!.hasAttribute("inert")).toBe(
        true,
      );
      await render(<Navigation account={account} />);
      expect(document.querySelector("[role=menu]")).toBeNull();
    },
  );

  it("is docked beside the page where the window is wide", () => {
    expect(docked()).toBe("docked");
    const aside = container.querySelector("aside.sidebar-column")!;
    expect(aside.hasAttribute("data-shown")).toBe(true);
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(button("Hide the sidebar").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("collapses and docks again from its toggle, which this device remembers", async () => {
    await act(async () => button("Hide the sidebar").click());
    expect(docked()).toBeNull();
    // The page's edge goes with it (styles.css).
    expect(
      container.querySelector(".home-screen")!.hasAttribute("data-sliding"),
    ).toBe(true);
    const aside = container.querySelector("aside.sidebar-column")!;
    expect(aside.hasAttribute("data-shown")).toBe(false);
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(button("Show the sidebar").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(localStorage.getItem("sanctum.preference.sidebar")).toBe(
      "collapsed",
    );

    // A new screen starts as this device left it.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await vi.waitFor(() => expect(docked()).toBeNull());

    await act(async () => button("Show the sidebar").click());
    expect(docked()).toBe("docked");
    expect(localStorage.getItem("sanctum.preference.sidebar")).toBe("docked");
  });

  it("takes the colour of the page: a place's deepened background, or the mode's", async () => {
    const neutral = container.querySelector(".frame-neutral")!;
    const place = container.querySelector<HTMLElement>(".frame-place")!;
    expect(place.hasAttribute("data-on")).toBe(true);
    expect(neutral.hasAttribute("data-on")).toBe(false);
    expect(place.style.background).toBe("var(--dashboard-mocha-deep)");
    expect(
      container
        .querySelector("aside.sidebar-column")!
        .getAttribute("data-mode"),
    ).toBe("evening");
    await render(<Navigation onDashboard={false} />);
    expect(place.hasAttribute("data-on")).toBe(false);
    expect(neutral.hasAttribute("data-on")).toBe(true);
  });

  it("lists the dashboards under their heading after the pins, in their order, Home with its house, the others with their background as a swatch", () => {
    const nav = container.querySelector("aside nav")!;
    expect(nav.firstElementChild?.getAttribute("aria-label")).toBe(
      "Pinned apps",
    );
    expect(nav.querySelector("h2")?.textContent).toBe("Dashboards");
    const items = [...nav.querySelectorAll(":scope > button")];
    expect(items.map((item) => item.textContent)).toEqual(["Home", "Night"]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([
      "page",
      null,
    ]);
    expect(items[0]!.querySelector("svg.lucide-house")).not.toBeNull();
    expect(
      items[1]!.querySelector<HTMLElement>("span[aria-hidden]")?.style
        .background,
    ).toBe("var(--dashboard-mocha)");
  });

  it("floats over the page where the window is too narrow, focus starting on the place on show and going back to the toggle", async () => {
    windowIs({ wide: false, hovers: false });
    await render(<Navigation key="narrow" />);
    expect(docked()).toBeNull();
    const trigger = button("Show the sidebar");
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.classList.contains("sidebar-float")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Home");
    expect(
      dialog.querySelector('button[aria-label="Hide the sidebar"]'),
    ).not.toBeNull();
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Radix hands focus back on a timer once the dialog has unmounted.
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("floats in from the window's left edge while collapsed, and leaves with the pointer", async () => {
    windowIs({ wide: true, hovers: true });
    await render(<Navigation key="hover" />);
    await act(async () => button("Hide the sidebar").click());
    const edge = container.querySelector(".sidebar-edge")!;
    const pointer = (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      target.dispatchEvent(event);
    };
    const focused = document.activeElement;
    await act(async () => pointer(edge, "pointerover"));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    // It moves no focus, dims nothing and keeps its own toggle.
    expect(document.activeElement).toBe(focused);
    expect(document.querySelector("[data-slot=dialog-overlay]")).toBeNull();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(
      dialog.querySelector('button[aria-label="Keep the sidebar shown"]'),
    ).not.toBeNull();
    await act(async () => pointer(dialog, "pointerover"));
    await act(async () => pointer(dialog, "pointerout"));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
  });

  it("does not come back at once while the pointer rests on the edge after it has gone", async () => {
    windowIs({ wide: true, hovers: true });
    await render(<Navigation key="rest" />);
    await act(async () => button("Hide the sidebar").click());
    const pointer = (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      target.dispatchEvent(event);
    };
    await act(async () =>
      pointer(container.querySelector(".sidebar-edge")!, "pointerover"),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    // The window's edge beside it counts as the sidebar.
    expect(dialog.hasAttribute("data-peek")).toBe(true);
    await act(async () => pointer(dialog, "pointerover"));
    await act(async () => pointer(dialog, "pointerout"));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await act(async () =>
      pointer(container.querySelector(".sidebar-edge")!, "pointerover"),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("docks from the floating sidebar's own toggle", async () => {
    windowIs({ wide: true, hovers: true });
    await render(<Navigation key="dock" />);
    await act(async () => button("Hide the sidebar").click());
    const event = new MouseEvent("pointerover", { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    await act(async () =>
      container.querySelector(".sidebar-edge")!.dispatchEvent(event),
    );
    await vi.waitFor(() =>
      expect(button("Keep the sidebar shown")).not.toBeNull(),
    );
    await act(async () => button("Keep the sidebar shown").click());
    expect(docked()).toBe("docked");
  });
});

describe("the pinned apps", () => {
  const pin = (app: ListedApp, current = false): PinnedApp => ({
    ...app,
    current,
  });
  const tiles = () =>
    [
      ...container.querySelectorAll(
        'aside ul[aria-label="Pinned apps"] button',
      ),
    ].map((each) => each.getAttribute("aria-label"));
  const columns = () =>
    container
      .querySelector<HTMLElement>('aside ul[aria-label="Pinned apps"]')!
      .style.getPropertyValue("--columns");

  it("share the row while there are fewer than four, Apps last, the current one marked", async () => {
    await render(<Navigation pinned={[pin(apps[0]!, true), pin(apps[1]!)]} />);
    expect(tiles()).toEqual(["Moods", "Example", "Apps"]);
    expect(columns()).toBe("3");
    expect(
      container
        .querySelector('aside button[aria-label="Moods"]')!
        .getAttribute("aria-current"),
    ).toBe("page");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('aside button[aria-label="Apps"]')!
        .click(),
    );
    expect(opened).toEqual(["apps"]);
  });

  it("go four to a row from the fourth tile, and later rows keep the width", async () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      pin({ ...apps[0]!, id: `app-${index}`, name: `App ${index}` }),
    );
    await render(<Navigation pinned={many} />);
    expect(tiles()).toHaveLength(6);
    expect(columns()).toBe("4");
  });

  it("say nothing about what is pinned until they are read, Apps holding its place", async () => {
    await render(<Navigation isLoading />);
    expect(tiles()).toEqual(["Apps"]);
    expect(columns()).toBe("4");
    expect(
      container.querySelector('aside button[aria-label="Apps"]')!.closest("li")!
        .className,
    ).toContain("col-start-4");
  });

  it("leave a dashed placeholder three tiles wide while nothing is pinned, which opens Apps to pin some", async () => {
    expect(tiles()).toEqual(["Pin apps", "Apps"]);
    expect(columns()).toBe("4");
    const placeholder = container.querySelector<HTMLButtonElement>(
      'aside button[aria-label="Pin apps"]',
    )!;
    expect(placeholder.className).toContain("border-dashed");
    expect(placeholder.closest("li")!.className).toContain("col-span-3");
    await act(async () => placeholder.click());
    expect(opened).toEqual(["pin apps"]);
  });
});

describe("Apps", () => {
  let pins: string[] = [];
  async function showApps(current: string[] = []) {
    pins = current;
    await render(
      <AppsPage
        apps={apps}
        pins={pins}
        onPins={(next) => {
          pins = next;
          void showApps(next);
        }}
      />,
    );
  }
  const names = () =>
    [...container.querySelectorAll("main li button, li button")].map((each) =>
      each.getAttribute("aria-label"),
    );

  async function type(value: string) {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search apps"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("lists every app it is given and opens the one pressed", async () => {
    await showApps();
    expect(container.querySelector("h1")?.textContent).toBe("Apps");
    expect(names()).toEqual(["Moods", "Example"]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("li button")!.click(),
    );
    expect(opened).toEqual(["sanctum.moods"]);
  });

  it("searches as you type, and says what found nothing", async () => {
    await showApps();
    await type("exa");
    expect(names()).toEqual(["Example"]);
    await type("  zzz ");
    expect(names()).toEqual([]);
    expect(container.textContent).toContain("No apps match “zzz”.");
  });

  it("pins and unpins with Pin apps, the pinned first in their order, until Done", async () => {
    await showApps(["sanctum.example"]);
    const pinApps = [...container.querySelectorAll("button")].find(
      (each) => each.textContent === "Pin apps",
    )!;
    await act(async () => pinApps.click());
    expect(container.querySelector("h1")?.textContent).toBe("Pin apps");
    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["Pinned", "Not pinned"]);
    expect(names()).toEqual(["Unpin Example", "Pin Moods"]);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Pin Moods"]')!
        .click(),
    );
    expect(pins).toEqual(["sanctum.example", "sanctum.moods"]);
    expect(names()).toEqual(["Unpin Example", "Unpin Moods"]);
    expect(container.textContent).toContain("Every app is pinned.");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Unpin Example"]')!
        .click(),
    );
    expect(pins).toEqual(["sanctum.moods"]);

    const done = [...container.querySelectorAll("button")].find(
      (each) => each.textContent === "Done",
    )!;
    await act(async () => done.click());
    expect(container.querySelector("h1")?.textContent).toBe("Apps");
    expect(opened).toEqual([]);
  });

  it("waits for the household's pins before pinning", async () => {
    await render(<AppsPage apps={apps} pins={undefined} onPins={() => {}} />);
    const pinApps = [...container.querySelectorAll("button")].find(
      (each) => each.textContent === "Pin apps",
    )!;
    expect(pinApps.disabled).toBe(true);
  });
});
