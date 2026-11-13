import {
  onBattery,
  type CapabilityInfo,
  type DeviceInfo,
  type LightCommand,
  type LightsPlace,
  type LightsRequest,
  type LightsResult,
  type LightsSwitch,
  type LiveMessage,
  type Places,
} from "@meetsanctum/app-sdk";
import type { LiveFeed, Tile } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { coreJson } from "./core-fetch";
import { useMinuteClock } from "./device-firmware";
import { tileKey, tilesOf } from "./device-tiles";

// The home's devices and places as the shell shows them, for the sidebar,
// the dashboard and room and category pages alike: read whenever the shell
// refreshes its live feed and kept current by it in between. A command from
// here, from a tile, a device's detail, a button for all the lights or a
// room section's tile, shows on its tile as pending at once; one that the
// core could not deliver or that the device did not confirm shows on its
// tile for a moment, without a message. A remote's press shows on its tile
// for a few seconds. While the home has a motion sensor, the tiles move on
// each minute, so "Quiet for 12 min" keeps counting.

// How long a command from here may take to show as pending, and how long
// after it went out a device that never confirms it still fails its tile,
// in ms: the core waits 6 s for the device once it has delivered it, and
// as long again once it has sent it again.
const pendingWithin = 10_000;
const confirmWithin = 90_000;
// How long a remote's tile shows a press, in ms.
export const pressShownMs = 5_000;

// A command from here, followed until its device confirms it or it fails.
type Sent = { at: number; pending: boolean; failed: boolean };

// The on or off and level a command from here asks of a tile, which the tile
// shows as pending from the moment it goes out, rather than once the core
// has taken it. Only what the core is sure to ask of the device shows: a
// colour, or a level held for a light that is off, waits for its answer.
type Asked = { on: boolean; brightness?: number };

function askedOf(command: LightCommand): Asked | undefined {
  if (command.on === false || command.brightness === 0) return { on: false };
  if (command.brightness !== undefined) {
    return { on: true, brightness: command.brightness };
  }
  return command.on === undefined ? undefined : { on: true };
}

function isAskedShown(capability: CapabilityInfo, asked: Asked) {
  return Object.entries(asked).every(
    ([field, value]) =>
      (capability.state as Record<string, unknown> | null)?.[field] === value,
  );
}

// The capability as the core will show it once it has taken the command.
function pendingAs(capability: CapabilityInfo, asked: Asked): CapabilityInfo {
  if (
    (capability.kind !== "light" && capability.kind !== "switch") ||
    isAskedShown(capability, asked)
  ) {
    return capability;
  }
  return {
    ...capability,
    state: { ...capability.state, ...asked },
    desired: { ...capability.desired, ...asked },
    sync: "pending",
  } as CapabilityInfo;
}

/** The devices and places this client may see, with what changes them. */
export function useDevices(live: LiveFeed) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [places, setPlaces] = useState<Places>();
  // Whether the core has answered with the home's devices yet.
  const [loaded, setLoaded] = useState(false);

  type DeviceUpdate = (current: DeviceInfo[]) => DeviceInfo[];
  const pendingLoad = useRef<{
    updates: DeviceUpdate[];
    places?: Places;
  } | null>(null);
  const [failures, setFailures] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // Each button's press of the last few seconds, by its tile's key.
  const [pressed, setPressed] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const pressTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const showPress = useCallback((key: string, action: string) => {
    setPressed((current) => new Map(current).set(key, action));
    clearTimeout(pressTimers.current.get(key));
    pressTimers.current.set(
      key,
      setTimeout(() => {
        pressTimers.current.delete(key);
        setPressed((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      }, pressShownMs),
    );
  }, []);
  useEffect(() => {
    const timers = pressTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  // What the latest command from here asks of each tile, by its key, until
  // the core has answered it; null forgets what an earlier one asked.
  const [asks, setAsks] = useState<
    ReadonlyMap<string, { asked: Asked; by: object }>
  >(() => new Map());
  const ask = useCallback((keys: string[], asked: Asked | null) => {
    const by = {};
    setAsks((current) => {
      const next = new Map(current);
      for (const key of keys) {
        if (asked) next.set(key, { asked, by });
        else next.delete(key);
      }
      return next;
    });
    // Answered: the tile shows what the core says, unless a later command
    // from here asks something else meanwhile.
    return () =>
      setAsks((current) => {
        const next = new Map(current);
        for (const key of keys) {
          if (next.get(key)?.by === by) next.delete(key);
        }
        return next.size === current.size ? current : next;
      });
  }, []);
  const fail = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setFailures((current) => {
      const next = new Map(current);
      for (const key of keys) next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
  }, []);
  const pendingCommands = useRef(
    new Set<{
      deviceId: string;
      capabilityId: string;
    }>(),
  );
  // The latest command from here for each tile. One the core gives up on,
  // its state going from pending to conflict, fails like one it could not
  // deliver: tapping a light that has no power should not pass quietly.
  // Other clients' commands stay quiet, and each command fails at most once.
  const sent = useRef(new Map<string, Sent>());
  const failOnce = useCallback(
    (commands: [string, Sent][]) => {
      const keys: string[] = [];
      for (const [key, command] of commands) {
        if (command.failed) continue;
        command.failed = true;
        keys.push(key);
      }
      fail(keys);
    },
    [fail],
  );
  // States are followed as they arrive, in the core's order, not as they
  // render, so updates batched into one render are not missed.
  const follow = useCallback(
    (deviceId: string, capabilities: CapabilityInfo[]) => {
      const now = Date.now();
      const failed: [string, Sent][] = [];
      for (const capability of capabilities) {
        const key = tileKey(deviceId, capability.id);
        const command = sent.current.get(key);
        if (!command) continue;
        const age = now - command.at;
        if (age > confirmWithin || (!command.pending && age > pendingWithin)) {
          sent.current.delete(key);
        } else if (capability.sync === "pending") {
          command.pending = true;
        } else if (command.pending) {
          // Confirmed, held until the light turns on, or given up on.
          sent.current.delete(key);
          if (capability.sync === "conflict") failed.push([key, command]);
        }
      }
      failOnce(failed);
    },
    [failOnce],
  );
  const send = useCallback((keys: string[]) => {
    const at = Date.now();
    return keys.map((key): [string, Sent] => {
      const command = { at, pending: false, failed: false };
      sent.current.set(key, command);
      return [key, command];
    });
  }, []);
  // Stops following commands that failed, unless a newer one replaced them.
  const forget = useCallback((commands: [string, Sent][]) => {
    for (const [key, command] of commands) {
      if (sent.current.get(key) === command) sent.current.delete(key);
    }
  }, []);

  // Replay changes received during a snapshot request over that snapshot.
  // Otherwise a slow HTTP response can undo a live update or a removal.
  const updateDevices = useCallback((update: DeviceUpdate) => {
    pendingLoad.current?.updates.push(update);
    setDevices(update);
  }, []);

  const load = useCallback(async () => {
    const request = {
      updates: [] as DeviceUpdate[],
      places: undefined as Places | undefined,
    };
    pendingLoad.current = request;
    try {
      const [nextDevices, nextPlaces] = await Promise.all([
        coreJson<DeviceInfo[]>("/api/devices"),
        coreJson<Places>("/api/places"),
      ]);
      if (pendingLoad.current !== request) return;
      const currentDevices = request.updates.reduce(
        (current, update) => update(current),
        nextDevices,
      );
      // Follow the replayed state too: an older snapshot must not confirm
      // or fail a command that a newer update still shows as pending.
      for (const device of currentDevices) {
        follow(device.id, device.capabilities);
      }
      setDevices(currentDevices);
      setPlaces(request.places ?? nextPlaces);
      setLoaded(true);
    } finally {
      if (pendingLoad.current === request) pendingLoad.current = null;
    }
  }, [follow]);

  const apply = useCallback(
    (message: LiveMessage) => {
      if (message.type === "places") {
        if (pendingLoad.current) pendingLoad.current.places = message.places;
        setPlaces(message.places);
        return;
      }
      if (message.type === "press") {
        showPress(tileKey(message.device, message.capability), message.action);
        return;
      }
      if (message.type !== "device") return;
      const { id, device } = message;
      for (const command of pendingCommands.current) {
        if (command.deviceId === id) pendingCommands.current.delete(command);
      }
      if (device) {
        // Once the core shows the requested state as pending, its updates
        // take over, even if the HTTP response is still on its way. A later
        // conflict or another client's command would revive the local guess.
        // Snapshots alone may still be from before the command.
        setAsks((current) => {
          if (current.size === 0) return current;
          const next = new Map(current);
          for (const capability of device.capabilities) {
            const key = tileKey(id, capability.id);
            const each = next.get(key);
            if (
              each &&
              capability.sync === "pending" &&
              isAskedShown(capability, each.asked)
            )
              next.delete(key);
          }
          return next.size === current.size ? current : next;
        });
        follow(id, device.capabilities);
      } else {
        for (const key of sent.current.keys()) {
          if (key.startsWith(`${id}/`)) sent.current.delete(key);
        }
      }
      updateDevices((current) => {
        if (!device) {
          return current.filter((each) => each.id !== id);
        }
        return current.some((each) => each.id === id)
          ? current.map((each) => (each.id === id ? device : each))
          : [...current, device];
      });
    },
    [updateDevices, follow, showPress],
  );

  // The core answers with the capability as it now stands, the asked-for
  // state pending until the device confirms it. When it cannot deliver the
  // command, it keeps the state from before and says so. A switch takes
  // only on or off: a brightness above 0 turns it on.
  const command = useCallback(
    async (tile: Tile, asked: LightCommand) => {
      // A later command or a live device update takes precedence over this
      // response, which may arrive after the device has already answered.
      for (const pending of pendingCommands.current) {
        if (
          pending.deviceId === tile.deviceId &&
          pending.capabilityId === tile.capabilityId
        ) {
          pendingCommands.current.delete(pending);
        }
      }
      const pending = {
        deviceId: tile.deviceId,
        capabilityId: tile.capabilityId,
      };
      pendingCommands.current.add(pending);
      const commands = send([tile.key]);
      const sending =
        tile.kind === "light"
          ? asked
          : { on: asked.on ?? (asked.brightness ?? 0) > 0 };
      const shown = askedOf(sending);
      const answered = shown ? ask([tile.key], shown) : undefined;
      try {
        const capability = await coreJson<CapabilityInfo>(
          "/api/devices/command",
          {
            method: "POST",
            json: {
              device: tile.deviceId,
              capability: tile.capabilityId,
              command: sending,
            },
          },
        );
        // The answer comes once the core has taken the command, so the state
        // in it is this command's: still pending, or already confirmed or
        // held, which ends it even if pending never showed here.
        const [, command] = commands[0]!;
        if (sent.current.get(tile.key) === command) {
          if (capability.sync === "pending") command.pending = true;
          else sent.current.delete(tile.key);
        }
        if (!pendingCommands.current.has(pending)) return;
        updateDevices((current) =>
          current.map((device) =>
            device.id === tile.deviceId
              ? {
                  ...device,
                  capabilities: device.capabilities.map((each) =>
                    each.id === capability.id ? capability : each,
                  ),
                }
              : device,
          ),
        );
      } catch (error) {
        // The core may already have put back the state from before, a
        // conflict among them, which failed the tile once.
        forget(commands);
        failOnce(commands);
        throw error;
      } finally {
        pendingCommands.current.delete(pending);
        answered?.();
      }
    },
    [updateDevices, send, forget, failOnce, ask],
  );

  const toggle = useCallback(
    (tile: Tile) => command(tile, { on: !tile.on }),
    [command],
  );

  // 0 turns a light off; anything more turns it on at that level.
  const dim = useCallback(
    (tile: Tile, brightness: number) => command(tile, { brightness }),
    [command],
  );

  // Every light in a room, a zone or the home, on or off, through the core,
  // as a workflow's lights step does. The live connection brings each
  // light's new state. The core names the lights it could not switch; when
  // the whole call fails, each of `lights` it would have switched failed.
  const switchLights = useCallback(
    async (place: LightsPlace, lights: Tile[], to: LightsSwitch = "toggle") => {
      const reachable = lights.filter((tile) => !tile.disabled);
      const on =
        to === "toggle" ? !reachable.some((tile) => tile.on) : to === "on";
      // The core decides which lights to switch from what it knows, which
      // may be newer than these tiles, so every light it might switch is
      // followed; one it leaves alone never shows as pending.
      const commands = send(reachable.map((tile) => tile.key));
      // A room's turn-on rule can leave individual lights off. Only the
      // core knows which ones it will turn on, so they wait for its live
      // state, and what an earlier command from here asked of them goes.
      const answered = on
        ? ask(
            reachable.map((tile) => tile.key),
            null,
          )
        : ask(
            reachable.filter((tile) => tile.on).map((tile) => tile.key),
            { on },
          );
      try {
        const result = await coreJson<LightsResult>("/api/devices/lights", {
          method: "POST",
          json: { place, to } satisfies LightsRequest,
        });
        const failed = new Set(
          result.failed.map((each) => tileKey(each.device, each.capability)),
        );
        const failedCommands = commands.filter(([key]) => failed.has(key));
        forget(failedCommands);
        failOnce(failedCommands);
        return result;
      } catch (error) {
        forget(commands);
        const switching = new Set(
          reachable.filter((tile) => tile.on !== on).map((tile) => tile.key),
        );
        failOnce(commands.filter(([key]) => switching.has(key)));
        throw error;
      } finally {
        answered();
      }
    },
    [send, forget, failOnce, ask],
  );

  // Read whenever the shell refreshes its live feed, which it first does
  // once the host has answered as itself, and followed over it in between.
  useEffect(
    () =>
      live.subscribe({
        message: apply,
        refresh: () => void load().catch(() => undefined),
      }),
    [live, apply, load],
  );

  // Presence's "Quiet for 12 min" counts on, and a device on a battery
  // whose driver no longer knows whether it answers turns quiet once a day
  // has passed (maintenance.ts), without a live message.
  const ticks = devices.some(
    (device) =>
      device.capabilities.some((each) => each.kind === "occupancy") ||
      (onBattery(device) && device.availability === "unknown"),
  );
  // The clock only moves the tiles on; they read the time afresh each time.
  const minute = useMinuteClock(ticks);
  const tiles = useMemo(() => {
    const shown =
      asks.size === 0
        ? devices
        : devices.map((device) => ({
            ...device,
            capabilities: device.capabilities.map((capability) => {
              const each = asks.get(tileKey(device.id, capability.id));
              return each ? pendingAs(capability, each.asked) : capability;
            }),
          }));
    return tilesOf(shown, places, pressed, Date.now()).map((tile) => {
      const failed = failures.get(tile.key);
      return failed ? { ...tile, failures: failed } : tile;
    });
  }, [devices, places, failures, pressed, asks, minute]);
  return {
    places,
    devices,
    loaded,
    tiles,
    load,
    apply,
    command,
    toggle,
    dim,
    switchLights,
    fail,
  };
}

export type Devices = ReturnType<typeof useDevices>;
