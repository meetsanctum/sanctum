import type {
  AppInfo,
  DeviceInfo,
  FoundDevice,
  PairingInfo,
  Room,
} from "@meetsanctum/app-sdk";
import { Button, type LiveFeed } from "@meetsanctum/ui-sdk";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DeviceChanges } from "./add-devices-cards";
import { ChoosePage, type Way } from "./add-devices-choose";
import { FoundPage, foundKey } from "./add-devices-found";
import { JoiningPage, type JoiningState } from "./add-devices-joining";
import { productName } from "./brand";
import { CoreError, coreJson } from "./core-fetch";
import { deviceProblem, updateDevice } from "./device-parts";
import { Overlay } from "./overlay";
import { useOverlayHost } from "./overlay-host";
import {
  addDevicesHint,
  isWaitingForSetUp,
  type ServiceNotSetUp,
} from "./system-status";

// Adding devices, for everyone, whatever the radio: an overlay of frosted
// glass over the whole window that first asks what you are adding. The
// devices drivers found, as on the home's network, are one way; each radio
// that lets new devices join is another, by its app's name. Each way is a
// page of its own with Back; only a radio's page lets devices join, that
// radio's alone, for four minutes, and leaving it or closing the overlay
// stops them. A device added or ready is named and put in a room on its
// card. Closing the overlay empties every answer typed in it.

type Opened = PairingInfo & { since: string };
type Page =
  { kind: "choose" } | { kind: "found" } | Extract<Way, { kind: "join" }>;

// How long a radio lets devices join each time: four minutes.
const joinSeconds = 240;

function openProblem(error: unknown) {
  if (error instanceof CoreError && error.status >= 500) {
    return `${productName} could not let devices join. Try again.`;
  }
  return deviceProblem(error);
}

const closePairing = () =>
  coreJson<PairingInfo>("/api/devices/pairing/close", {
    method: "POST",
    json: {},
  });

export function AddDevices(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  apps: readonly AppInfo[];
  // Adding devices as the core last said it: what drivers found, and which
  // let devices join or find them. An older core says neither.
  adding?: PairingInfo;
  // The services the home never set up, to say what to plug in.
  notSetUp?: readonly ServiceNotSetUp[];
  live: LiveFeed;
  onChanged: (device: DeviceInfo) => void;
}) {
  const host = useOverlayHost();
  const [page, setPage] = useState<Page>({ kind: "choose" });
  const [pairing, setPairing] = useState<PairingInfo>();
  // What joined from the first time this overlay let devices join.
  const [since, setSince] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [opening, setOpening] = useState(false);
  // Whether someone stopped devices joining, rather than the time running out.
  const [stopped, setStopped] = useState(false);
  // Whether the radio could not start letting devices join.
  const [failed, setFailed] = useState(false);
  // The core's clock less this one's, so the countdown keeps the core's time.
  const offset = useRef(0);
  // Which time the overlay was opened; an answer for an earlier one is late.
  const session = useRef(0);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  // Whether this overlay let devices join and has not stopped them since.
  const needsClose = useRef(false);
  const isDismissing = useRef(false);
  // Whether Done could not stop new devices joining; then it closes the
  // overlay anyway, since each network closes by itself when its time is up.
  const [stopFailed, setStopFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The found devices the overlay shows, in the order it first showed them,
  // and those added here, which stay to be named and placed.
  const [shown, setShown] = useState<FoundDevice[]>([]);
  const [added, setAdded] = useState<Record<string, DeviceInfo>>({});
  const [pendingAdds, setPendingAdds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const saveAttempts = useRef(new Map<string, symbol>());

  // A request must finish before a later one reaches the radios, including
  // when an open is still waiting on a radio as the overlay closes.
  const sequence = useCallback(<T,>(request: () => Promise<T>) => {
    const result = pending.current.then(request);
    pending.current = result.catch(() => undefined);
    return result;
  }, []);
  // Once stopped, nothing is left to stop; one that failed is tried again
  // as the overlay closes.
  const close = useCallback(
    () =>
      sequence(closePairing).then((closed) => {
        needsClose.current = false;
        return closed;
      }),
    [sequence],
  );

  const open = useCallback(
    async (driver: string | null) => {
      if (isDismissing.current) return;
      const current = session.current;
      needsClose.current = true;
      setOpening(true);
      setStopped(false);
      setFailed(false);
      setProblem(undefined);
      try {
        let startedAt = Date.now();
        const opened = await sequence(() => {
          startedAt = Date.now();
          return coreJson<Opened>("/api/devices/pairing/open", {
            method: "POST",
            json: driver
              ? { seconds: joinSeconds, drivers: [driver] }
              : { seconds: joinSeconds },
          });
        });
        if (current !== session.current) return;
        offset.current = Date.parse(opened.since) - startedAt;
        setSince((first) => first ?? opened.since);
        setPairing(opened);
      } catch (error) {
        if (current !== session.current) return;
        setFailed(true);
        setProblem(
          error instanceof CoreError && error.code === "unavailable"
            ? "It isn't running, so it can't let devices join now."
            : openProblem(error),
        );
      } finally {
        if (current === session.current) setOpening(false);
      }
    },
    [sequence],
  );

  const stop = async () => {
    const current = session.current;
    setProblem(undefined);
    try {
      const closed = await close();
      if (current === session.current) {
        setStopped(true);
        setPairing(closed);
      }
    } catch (error) {
      if (current === session.current) setProblem(deviceProblem(error));
    }
  };

  const choose = (way: Way) => {
    setProblem(undefined);
    if (way.kind === "found") setPage({ kind: "found" });
    if (way.kind === "join") {
      setPage(way);
      void open(way.driver);
    }
  };

  // Back to the choice; leaving a radio's page stops devices joining it.
  const back = () => {
    setProblem(undefined);
    if (page.kind === "join" && needsClose.current) {
      void close()
        .then((closed) => setPairing(closed))
        .catch(() => undefined);
    }
    setPage({ kind: "choose" });
  };

  const dismiss = async () => {
    if (isDismissing.current) return;
    if (stopFailed || !needsClose.current) {
      props.onOpenChange(false);
      return;
    }
    isDismissing.current = true;
    const current = session.current;
    setProblem(undefined);
    try {
      await close();
      if (current === session.current) props.onOpenChange(false);
    } catch (error) {
      if (current === session.current) {
        setStopFailed(true);
        setProblem(
          error instanceof CoreError
            ? `${productName} could not stop new devices joining. They can until the time is up.`
            : deviceProblem(error),
        );
      }
    } finally {
      if (current === session.current) isDismissing.current = false;
    }
  };

  // Each opening starts on the choice; closing stops devices joining.
  useEffect(() => {
    if (!props.open) return;
    session.current += 1;
    isDismissing.current = false;
    needsClose.current = false;
    setPage({ kind: "choose" });
    setStopFailed(false);
    setStopped(false);
    setFailed(false);
    setProblem(undefined);
    setSince(undefined);
    setPairing(undefined);
    setShown([]);
    setAdded({});
    setPendingAdds(new Set());
    return () => {
      session.current += 1;
      if (needsClose.current) void close().catch(() => undefined);
    };
  }, [props.open, close]);

  // A save can finish after the overlay closes, so keep following live
  // devices.
  useEffect(() => {
    const current = session.current;
    // A read the live feed or a later read has overtaken is out of date.
    let revision = 0;
    return props.live.subscribe({
      message(message) {
        if (message.type === "device") saveAttempts.current.delete(message.id);
        if (!props.open || message.type !== "pairing") return;
        revision += 1;
        setPairing(message.pairing);
      },
      refresh() {
        if (!props.open) return;
        const requested = ++revision;
        void coreJson<PairingInfo>("/api/devices/pairing")
          .then((next) => {
            if (current === session.current && requested === revision) {
              setPairing(next);
            }
          })
          .catch(() => undefined);
      },
    });
  }, [props.open, props.live]);

  // Found devices keep their place: one that goes is dropped, unless it was
  // added here or its Add is still waiting, and one that comes goes last.
  const found = pairing?.found ?? props.adding?.found;
  useEffect(() => {
    if (!props.open) return;
    setShown((before) => {
      const now = new Map((found ?? []).map((each) => [foundKey(each), each]));
      const known = new Set(before.map(foundKey));
      return [
        ...before.flatMap((each) => {
          const key = foundKey(each);
          const current = now.get(key);
          return current
            ? [current]
            : Object.hasOwn(added, key) || pendingAdds.has(key)
              ? [each]
              : [];
        }),
        ...(found ?? []).filter((each) => !known.has(foundKey(each))),
      ];
    });
  }, [props.open, found, added, pendingAdds]);

  const until = pairing?.until ?? null;
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [until]);
  const secondsLeft = until
    ? Math.max(
        0,
        Math.ceil((Date.parse(until) - (now + offset.current)) / 1_000),
      )
    : 0;

  const appName = (id: string) =>
    props.apps.find((app) => app.id === id)?.name ?? null;

  // The ways the home has: what drivers find, while any does or something
  // was found; each radio that lets devices join, or one unnamed radio from
  // an older core; and a radio whose app waits for what was never set up.
  const drivers = pairing?.drivers ?? props.adding?.drivers;
  const finders = pairing?.finders ?? props.adding?.finders ?? [];
  const ways: Way[] = [];
  if (finders.length > 0 || shown.length > 0) {
    ways.push({ kind: "found", count: shown.length });
  }
  if (drivers === undefined) {
    ways.push({ kind: "join", driver: null, name: "New devices" });
  } else {
    for (const driver of drivers) {
      ways.push({
        kind: "join",
        driver,
        name: appName(driver) ?? "New devices",
      });
    }
  }
  const fix = addDevicesHint(props.apps, props.notSetUp);
  const waiting = props.apps.find(
    (app) =>
      !drivers?.includes(app.id) &&
      isWaitingForSetUp(app, props.notSetUp ?? []),
  );
  if (fix && waiting) {
    ways.push({ kind: "notSetUp", name: waiting.name, fix });
  }

  const save = async (device: DeviceInfo, changes: DeviceChanges) => {
    const attempt = Symbol();
    const current = session.current;
    saveAttempts.current.set(device.id, attempt);
    setProblem(undefined);
    try {
      const response = await updateDevice(device.id, changes);
      if (saveAttempts.current.get(device.id) === attempt)
        props.onChanged(response);
    } catch (error) {
      if (
        current === session.current &&
        saveAttempts.current.get(device.id) === attempt
      )
        setProblem(deviceProblem(error));
    } finally {
      if (saveAttempts.current.get(device.id) === attempt)
        saveAttempts.current.delete(device.id);
    }
  };

  const joinedHere =
    page.kind === "join" && since
      ? (pairing?.joined ?? []).filter(
          (each) =>
            Date.parse(each.joinedAt) >= Date.parse(since) &&
            (page.driver === null || each.driver === page.driver),
        )
      : [];
  const joining: JoiningState =
    opening && !pairing?.until
      ? { kind: "opening" }
      : secondsLeft > 0
        ? { kind: "open", secondsLeft }
        : {
            kind: "closed",
            why: failed ? "failed" : stopped ? "stopped" : "time",
          };

  const title =
    page.kind === "found"
      ? "Devices found"
      : page.kind === "join"
        ? page.name
        : "Add devices";
  // What is going on, for a screen reader, without the seconds ticking.
  const status =
    page.kind !== "join"
      ? ""
      : joining.kind === "open"
        ? "Looking for devices"
        : joining.kind === "closed"
          ? joining.why === "stopped"
            ? "Stopped looking"
            : joining.why === "time"
              ? "Time's up"
              : ""
          : "";

  return (
    <Overlay
      container={host.container}
      open={props.open}
      onClose={() => void dismiss()}
      onCovering={host.onCovering}
      title={title}
      subtitle={
        page.kind === "found"
          ? shown.length > 0
            ? `${shown.length} found`
            : "None found"
          : undefined
      }
      doneVariant="link"
      leading={
        page.kind !== "choose" && (
          <Button
            variant="link"
            aria-label="Back to Add devices"
            onClick={back}
          >
            <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            Add devices
          </Button>
        )
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          data-slot="overlay-content"
          className="mx-auto flex min-h-full w-full max-w-245 flex-col gap-6 ps-[calc(24px+env(safe-area-inset-left))] pe-[calc(24px+env(safe-area-inset-right))] pt-4 pb-[calc(32px+env(safe-area-inset-bottom))]"
        >
          {page.kind === "choose" && (
            <ChoosePage ways={ways} onChoose={choose} />
          )}
          {page.kind === "found" && (
            <FoundPage
              shown={shown}
              added={added}
              devices={props.devices}
              rooms={props.rooms}
              appName={appName}
              onWorkingChange={(key, isWorking) =>
                setPendingAdds((before) => {
                  const next = new Set(before);
                  if (isWorking) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
              onAdded={(key, device) => {
                setAdded((before) => ({ ...before, [key]: device }));
                props.onChanged(device);
              }}
              onSave={save}
            />
          )}
          {page.kind === "join" && (
            <JoiningPage
              name={page.driver ? page.name : null}
              state={joining}
              joined={joinedHere}
              devices={props.devices}
              rooms={props.rooms}
              seconds={joinSeconds}
              onStop={() => void stop()}
              onStartAgain={() => void open(page.driver)}
              onSave={save}
            />
          )}
          <p role="status" className="sr-only">
            {status}
          </p>
          {problem && (
            <p
              role="alert"
              className="m-0 text-center text-sm text-(--ruby-on-carbon)"
            >
              {problem}
            </p>
          )}
          {stopFailed && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => props.onOpenChange(false)}
              >
                Close anyway
              </Button>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
