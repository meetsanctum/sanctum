import type {
  AppInfo,
  LiveMessage,
  TemperatureUnit,
} from "@meetsanctum/app-sdk";

import type { PageParams } from "../app-ui";

// What an app's page in its frame and the shell say to each other. The
// frame says hello to its parent with the one-time code the shell put in
// its address; the shell answers that window, and only that one, with one
// end of a message channel, and from then on they talk only over that
// port. The frame asks for a fixed set of operations by name, each with an
// id, and the shell answers each; it never sends a URL, method or header.

/** The version of what's said here; a client from before a page's can't show it. */
export const frameBridge = 1;

/** The first message, from the frame to its parent, before there's a port. */
export type FrameHello = { sanctum: "hello"; code: string; bridge: number };
/** The shell's answer to it, which carries the port. */
export type FramePort = { sanctum: "port"; bridge: number };

/** What the shell tells a page about where it's shown. */
export type FrameContext = {
  mode: "day" | "evening";
  temperatureUnit: TemperatureUnit | null;
  timeZone: string | null;
};

/** The operations a page may ask for: each of AppClient's, by name. */
export type FrameOperation =
  | { op: "call"; actionId: string; input: unknown }
  | { op: "places" }
  | { op: "devices" }
  | { op: "command"; command: unknown }
  | { op: "entities" }
  | { op: "settings" }
  | { op: "ask"; permissions: string[] };

export type FromFrame =
  | ({ type: "request"; id: number } & FrameOperation)
  | { type: "subscribe"; on: boolean }
  // The title and actions the shell's top bar shows, new with each revision.
  | {
      type: "bar";
      title: string;
      actions: FrameBarAction[];
      revision: number;
    }
  | { type: "open"; page: string; params: PageParams }
  | { type: "back" }
  | { type: "openSettings" }
  | { type: "ready" }
  // Its files didn't load, or it stopped working once drawn.
  | { type: "failed"; reason: "files" | "stopped"; message: string };

/** An action in the top bar as the shell draws it, without its handler. */
export type FrameBarAction = {
  id: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
};

export type ToFrame =
  | {
      type: "setup";
      app: AppInfo;
      page: string;
      params: PageParams;
      context: FrameContext;
    }
  | { type: "app"; app: AppInfo }
  | { type: "context"; context: FrameContext }
  | { type: "show"; page: string; params: PageParams }
  | { type: "answer"; id: number; ok: true; value: unknown }
  | {
      type: "answer";
      id: number;
      ok: false;
      error: { message: string; code?: string };
    }
  | { type: "live"; message: LiveMessage }
  | { type: "refresh" }
  // An action pressed in the top bar, as drawn at that revision.
  | { type: "press"; id: string; revision: number };

/** Whether a message is a frame's hello, before anything else is believed of it. */
export function isFrameHello(data: unknown): data is FrameHello {
  const hello = data as Partial<FrameHello> | null;
  return (
    typeof hello === "object" &&
    hello !== null &&
    hello.sanctum === "hello" &&
    typeof hello.code === "string" &&
    typeof hello.bridge === "number"
  );
}
