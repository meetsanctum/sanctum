import type {
  AppInfo,
  DeviceInfo,
  DeviceOffer,
  FoundDevice,
  PairingInfo,
  Room,
} from "@meetsanctum/app-sdk";
import { Button, ScrollArea, type LiveFeed } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { CardWork, DeviceChanges } from "./add-devices-cards";
import { ChoosePage, type Way } from "./add-devices-choose";
import { FoundPage, foundKey } from "./add-devices-found";
import { JoiningPage, type JoiningState } from "./add-devices-joining";
import { OfferedAppSheet } from "./add-devices-offer";
import { productName } from "./brand";
import { CoreError, coreJson } from "./core-fetch";
import { deviceProblem, updateDevice } from "./device-parts";
import { EditDevice, type Editing } from "./edit-device";
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
// that lets new devices join is another, by its app's name. An app the home
// could add for devices found on its network opens its add sheet, and once
// it's added, Devices found. Each way is a page of its own with Back; only a
// radio's page lets devices join, that radio's alone, for four minutes, and
// leaving it or closing the overlay stops them. A device added or ready is
// named and put in a room on its card. Closing the overlay empties every
// answer typed in it.

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

// The scroll area's content fills it, so a page can sit in its middle.
const pageScroll = cn(
  "min-h-0 flex-1",
  "[&>[data-slot=scroll-area-viewport]>div]:flex! [&>[data-slot=scroll-area-viewport]>div]:min-h-full",
  "[&>[data-slot=scroll-area-viewport]]:[mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-32px),transparent)]",
);

export function AddDevices(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  apps: readonly AppInfo[];
  // Adding devices as the core last said it: what drivers found, and which
  // let devices join or find them.
  adding?: PairingInfo;
  // The services the home never set up, to say what to plug in.
  notSetUp?: readonly ServiceNotSetUp[];
  live: LiveFeed;
  onChanged: (device: DeviceInfo) => void;
  // A device removed here, from a card Sanctum can't use.
  onRemoved?: (id: string) => void;
}) {
  const host = useOverlayHost();
  const [page, setPage] = useState<Page>({ kind: "choose" });
  const scrollArea = useRef<HTMLDivElement>(null);
  const [pairing, setPairing] = useState<PairingInfo>();
  // A command or live update overtakes any read already under way.
  const pairingRevision = useRef(0);
  const receivePairing = useCallback((next: PairingInfo) => {
    pairingRevision.current += 1;
    setPairing(next);
  }, []);
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
  // Rooms made here, until the home's rooms say so too.
  const [madeRooms, setMadeRooms] = useState<Room[]>([]);
  // The device whose removal is being asked about.
  const [removing, setRemoving] = useState<Editing>();
  // The app whose add sheet is open, from its offer.
  const [offered, setOffered] = useState<{
    offer: DeviceOffer;
    opener: HTMLButtonElement;
    dialog: HTMLElement | null;
    session: number;
  }>();
  const closeOffer = useCallback(() => setOffered(undefined), []);
  const backButton = useRef<HTMLButtonElement>(null);
  // The devices already greeted as new, so that each is greeted once.
  const greeted = useRef(new Set<string>());

  useEffect(() => {
    const waiting = madeRooms.filter(
      (made) => !props.rooms.some((room) => room.id === made.id),
    );
    if (waiting.length !== madeRooms.length) setMadeRooms(waiting);
  }, [madeRooms, props.rooms]);

  // A request must finish before a later one reaches the radios, including
  // when an open is still waiting on a radio as the overlay closes.
  const sequence = useCallback(<T,>(request: () => Promise<T>) => {
    const result = pending.current.then(request);
    pending.current = result.catch(() => undefined);
    return result;
  }, []);
  // Once stopped, nothing is left to stop; one that failed is tried again
  // as the overlay closes.
  const close = useCallback(() => {
    const current = session.current;
    return sequence(async () => {
      const requested = pairingRevision.current;
      const closed = await closePairing();
      needsClose.current = false;
      if (
        current === session.current &&
        requested === pairingRevision.current
      ) {
        receivePairing(closed);
      }
      return closed;
    });
  }, [sequence, receivePairing]);

  const open = useCallback(
    async (driver: string) => {
      if (isDismissing.current) return;
      const current = session.current;
      needsClose.current = true;
      setOpening(true);
      setStopped(false);
      setFailed(false);
      setStopFailed(false);
      setProblem(undefined);
      try {
        let startedAt = Date.now();
        let requested = pairingRevision.current;
        const opened = await sequence(() => {
          // A preceding overlay's close may have finished while this open
          // was queued. This radio still needs to be stopped when we leave.
          needsClose.current = true;
          startedAt = Date.now();
          requested = pairingRevision.current;
          return coreJson<Opened>("/api/devices/pairing/open", {
            method: "POST",
            json: { seconds: joinSeconds, drivers: [driver] },
          });
        });
        if (current !== session.current) return;
        offset.current = Date.parse(opened.since) - startedAt;
        setSince((first) => first ?? opened.since);
        if (requested === pairingRevision.current) receivePairing(opened);
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
    [sequence, receivePairing],
  );

  const stop = async () => {
    const current = session.current;
    setProblem(undefined);
    try {
      await close();
      if (current === session.current) {
        setStopped(true);
      }
    } catch (error) {
      if (current === session.current) setProblem(deviceProblem(error));
    }
  };

  const choose = (way: Way, opener: HTMLButtonElement) => {
    setProblem(undefined);
    setOffered(
      way.kind === "offer"
        ? {
            offer: way.offer,
            opener,
            dialog: opener.closest<HTMLElement>('[role="dialog"]'),
            session: session.current,
          }
        : undefined,
    );
    if (way.kind === "found") setPage({ kind: "found" });
    if (way.kind === "join") {
      setPage(way);
      void open(way.driver);
    }
  };

  // Back to the choice; leaving a radio's page stops devices joining it.
  const back = async () => {
    if (isDismissing.current) return;
    setProblem(undefined);
    if (page.kind !== "join" || !needsClose.current) {
      setPage({ kind: "choose" });
      return;
    }
    isDismissing.current = true;
    const current = session.current;
    try {
      await close();
      if (current === session.current) {
        setPage({ kind: "choose" });
      }
    } catch (error) {
      if (current === session.current) setProblem(deviceProblem(error));
    } finally {
      if (current === session.current) isDismissing.current = false;
    }
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
    setOffered(undefined);
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

  // Start the new page at its top without remounting pending device cards.
  useLayoutEffect(() => {
    if (!props.open) return;
    const viewport = scrollArea.current?.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    );
    if (viewport) viewport.scrollTop = 0;
  }, [page.kind, props.open]);

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
        receivePairing(message.pairing);
      },
      refresh() {
        if (!props.open) return;
        const requested = ++revision;
        const pairingAtRead = pairingRevision.current;
        void coreJson<PairingInfo>("/api/devices/pairing")
          .then((next) => {
            if (
              current === session.current &&
              requested === revision &&
              pairingAtRead === pairingRevision.current
            ) {
              setPairing(next);
            }
          })
          .catch(() => undefined);
      },
    });
  }, [props.open, props.live, receivePairing]);

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
  // was found; each radio that lets devices join; and a radio whose app
  // waits for what was never set up.
  const drivers = pairing?.drivers ?? props.adding?.drivers ?? [];
  const finders = pairing?.finders ?? props.adding?.finders ?? [];
  const ways: Way[] = [];
  if (finders.length > 0 || shown.length > 0) {
    ways.push({ kind: "found", count: shown.length });
  }
  for (const driver of drivers) {
    ways.push({
      kind: "join",
      driver,
      name: appName(driver) ?? "New devices",
    });
  }
  for (const offer of pairing?.offers ?? props.adding?.offers ?? []) {
    ways.push({ kind: "offer", offer });
  }
  const fix = addDevicesHint(props.apps, props.notSetUp);
  const waiting = props.apps.find(
    (app) =>
      !drivers.includes(app.id) && isWaitingForSetUp(app, props.notSetUp ?? []),
  );
  if (fix && waiting) {
    ways.push({ kind: "notSetUp", name: waiting.name, fix });
  }

  const save = async (
    device: DeviceInfo,
    changes: DeviceChanges,
  ): Promise<boolean> => {
    const attempt = Symbol();
    const current = session.current;
    saveAttempts.current.set(device.id, attempt);
    setProblem(undefined);
    try {
      const response = await updateDevice(device.id, changes);
      if (saveAttempts.current.get(device.id) === attempt)
        props.onChanged(response);
      return true;
    } catch (error) {
      if (
        current === session.current &&
        saveAttempts.current.get(device.id) === attempt
      )
        setProblem(deviceProblem(error));
      return false;
    } finally {
      if (saveAttempts.current.get(device.id) === attempt)
        saveAttempts.current.delete(device.id);
    }
  };

  const rooms = [
    ...props.rooms,
    ...madeRooms.filter(
      (made) => !props.rooms.some((room) => room.id === made.id),
    ),
  ];
  const work: CardWork = {
    rooms,
    onSave: save,
    onAddRoom: async (name) => {
      const room = await coreJson<Room>("/api/places/rooms/add", {
        method: "POST",
        json: { name },
      });
      setMadeRooms((before) => [...before, room]);
      return room.id;
    },
    onRemove: (device) => setRemoving({ action: "remove", device }),
    isFresh: (id) => !greeted.current.has(id),
    onGreeted: (id) => greeted.current.add(id),
  };

  // A ready device with no id was removed and leaves the list.
  const joinedHere =
    page.kind === "join" && since
      ? (pairing?.joined ?? []).filter(
          (each) =>
            Date.parse(each.joinedAt) >= Date.parse(since) &&
            each.driver === page.driver &&
            (each.stage !== "ready" || each.deviceId !== null),
        )
      : [];
  const joining: JoiningState =
    opening && secondsLeft === 0
      ? { kind: "opening" }
      : secondsLeft > 0
        ? { kind: "open", secondsLeft }
        : {
            kind: "closed",
            why: failed ? "failed" : stopped ? "stopped" : "time",
          };
  // Failed joins tell the user to reset the device and start again.
  const isDonePrimary =
    joining.kind === "closed" &&
    joinedHere.some((each) => each.stage !== "failed");

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
      onEscapeKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-slot="add-devices-new-room"]')
        )
          event.preventDefault();
      }}
      onCovering={host.onCovering}
      isDonePrimary={isDonePrimary}
      title={title}
      subtitle={
        page.kind === "found"
          ? shown.length > 0
            ? `${shown.length} found`
            : "None found"
          : undefined
      }
      footer={
        page.kind === "found" &&
        shown.length > 0 && (
          <p className="m-0 text-center text-sm text-(--silver)">
            Don't see yours? Check it's switched on and connected to your Wi‑Fi.
          </p>
        )
      }
      leading={
        page.kind !== "choose" && (
          <Button
            ref={backButton}
            variant="outline"
            aria-label="Back to Add devices"
            onClick={() => void back()}
          >
            <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            Add devices
          </Button>
        )
      }
    >
      {/* The page scrolls between the header and the footer, fading out
          under each as far as its own padding reaches. */}
      <ScrollArea ref={scrollArea} type="scroll" className={pageScroll}>
        <div
          data-slot="overlay-content"
          className="mx-auto flex w-full max-w-245 min-w-0 flex-1 flex-col gap-6 ps-[calc(24px+env(safe-area-inset-left))] pe-[calc(24px+env(safe-area-inset-right))] pt-4 pb-[calc(32px+env(safe-area-inset-bottom))]"
        >
          {page.kind === "choose" && (
            <ChoosePage ways={ways} onChoose={choose} />
          )}
          {(page.kind === "found" || pendingAdds.size > 0) && (
            // Keep pending adds alive across Back, so returning cannot add
            // twice and their results still become cards to name and place.
            <div
              hidden={page.kind !== "found"}
              className="flex flex-1 flex-col"
            >
              <FoundPage
                shown={shown}
                added={added}
                devices={props.devices}
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
                work={work}
              />
            </div>
          )}
          {page.kind === "join" && (
            <JoiningPage
              name={appName(page.driver)}
              state={joining}
              joined={joinedHere}
              isDonePrimary={isDonePrimary}
              devices={props.devices}
              seconds={joinSeconds}
              onStop={() => void stop()}
              onStartAgain={() => void open(page.driver)}
              work={work}
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
      </ScrollArea>
      {props.open && page.kind === "choose" && offered && (
        <OfferedAppSheet
          key={offered.offer.app}
          offer={offered.offer}
          onAdded={() => {
            if (offered.session !== session.current) return;
            setOffered(undefined);
            // What it finds is added from there.
            setPage({ kind: "found" });
          }}
          onClose={closeOffer}
          onProblem={setProblem}
          restoreFocus={() => {
            if (offered.session !== session.current) return;
            const { opener, dialog } = offered;
            (opener.isConnected
              ? opener
              : (backButton.current ?? dialog)
            )?.focus();
          }}
        />
      )}
      <EditDevice
        editing={removing}
        appName={removing ? appName(removing.device.driver) : null}
        onClose={() => setRemoving(undefined)}
        onChanged={props.onChanged}
        onRemoved={(id) => {
          saveAttempts.current.delete(id);
          // A read begun before the removal would bring the device back.
          pairingRevision.current += 1;
          setPairing((before) =>
            before
              ? {
                  ...before,
                  joined: before.joined.map((each) =>
                    each.deviceId === id
                      ? { ...each, deviceId: null, known: false }
                      : each,
                  ),
                }
              : before,
          );
          props.onRemoved?.(id);
        }}
        onForgotten={() => undefined}
      />
    </Overlay>
  );
}
