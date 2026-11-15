import {
  capabilityKinds,
  controlPermission,
  readPermission,
  registerPermission,
  type CapabilityKind,
} from "./devices.js";

// Device pages: a page an app adds to the detail of every device with a
// capability kind it names, after the shell's own, such as Moods' Presses
// page for remotes, or a driver's page on its own devices alone, whatever
// they can do. The manifest declares it, so the shell knows which detail
// shows it without running the app; the app's UI draws it (defineAppUi's
// devicePages, in @meetsanctum/ui-sdk) with the device as the app may see
// it, a driver its own devices whole.

type PageBase = {
  /** Namespaced, such as moods.presses; its component's key in the app's UI. */
  readonly id: string;
  /** Its tab's name in the detail, such as Presses. */
  readonly title: string;
};

export type DevicePageDefinition =
  | (PageBase & {
      /** The capability kinds of the devices whose detail shows it. */
      readonly kinds: readonly CapabilityKind[];
    })
  | (PageBase & {
      /** The devices the driver brings, and those alone. */
      readonly devices: "own";
    });

/**
 * A device page as clients see it (GET /api/apps). A driver's page on its
 * own devices has no kinds, so a client from before shows it nowhere.
 */
export type DevicePageInfo = {
  id: string;
  title: string;
  kinds: CapabilityKind[];
  devices?: "own";
};

export function defineDevicePage(
  page: DevicePageDefinition,
): DevicePageDefinition {
  return page;
}

export function devicePageInfo(page: DevicePageDefinition): DevicePageInfo {
  return "devices" in page
    ? { id: page.id, title: page.title, kinds: [], devices: "own" }
    : { id: page.id, title: page.title, kinds: [...page.kinds] };
}

const pageId = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * Each device page's id, title and what it's for: kinds the app may read, or
 * the devices a driver brings.
 */
export function assertDevicePages(app: {
  readonly permissions: readonly string[];
  readonly provides?: {
    readonly devicePages?: readonly DevicePageDefinition[];
  };
}) {
  const pages = app.provides?.devicePages ?? [];
  if (!Array.isArray(pages)) {
    throw new Error("An app provides a list of device pages");
  }
  const seen = new Set<string>();
  for (const page of pages) {
    const id = String(page?.id);
    if (!pageId.test(id) || typeof page.title !== "string" || !page.title) {
      throw new Error(
        `Device page "${id}" needs a namespaced id, such as moods.presses, and a title`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`Device page "${id}" is declared twice`);
    }
    seen.add(id);
    if ("devices" in page) {
      if (page.devices !== "own" || "kinds" in page) {
        throw new Error(
          `Device page "${id}" is for kinds, or for the devices it brings with devices: "own"`,
        );
      }
      if (!app.permissions.includes(registerPermission)) {
        throw new Error(
          `Device page "${id}" is for the devices it brings, which only a driver does`,
        );
      }
      continue;
    }
    if (!Array.isArray(page.kinds) || page.kinds.length === 0) {
      throw new Error(`Device page "${id}" names the kinds it is for`);
    }
    for (const kind of page.kinds) {
      if (!capabilityKinds.includes(kind)) {
        throw new Error(
          `Device page "${id}" names ${String(kind)}, which is no kind`,
        );
      }
      if (
        !app.permissions.includes(readPermission(kind)) &&
        !app.permissions.includes(controlPermission(kind))
      ) {
        throw new Error(
          `Device page "${id}" is for ${kind}s, which the app may not read`,
        );
      }
    }
  }
}
