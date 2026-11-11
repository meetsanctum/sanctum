import type {
  DeviceInfo,
  JoinedDevice,
  PairingInfo,
  Room,
} from "@meetsanctum/app-sdk";
import { Button, Input, type LiveFeed } from "@meetsanctum/ui-sdk";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import {
  DeviceIcon,
  deviceProblem,
  RoomPicker,
  updateDevice,
} from "./device-parts";
import { KnotLoader } from "./knot-loader";

// Adding devices: the core's pairing flow, which the shell brings for
// everyone, whatever the radio. Opening the dialog lets new devices join for
// four minutes, with the time left and a way to stop; each device that joins
// shows as it gets on, and once it is ready it is named and put in a room
// right here. Closing the dialog stops new devices joining.

type Opened = PairingInfo & { since: string };

/** Minutes and seconds, as a countdown shows them: 3:52. */
export function countdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How far a device that joined has come, as the dialog says it. */
export function stageText(joined: JoinedDevice) {
  switch (joined.stage) {
    case "joined":
      return "Joining…";
    case "interviewing":
      return "Setting up…";
    case "ready":
      return joined.known ? "Joined again" : "Ready";
    case "unsupported":
      return `${productName} cannot use it`;
    case "failed":
      return "It did not finish joining. Reset it and try again.";
  }
}

function openProblem(error: unknown) {
  if (error instanceof CoreError && error.code === "unavailable") {
    return "No app that adds devices is running.";
  }
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
  live: LiveFeed;
  onChanged: (device: DeviceInfo) => void;
}) {
  const [pairing, setPairing] = useState<PairingInfo>();
  // What joined from the first time this dialog opened the network.
  const [since, setSince] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [opening, setOpening] = useState(false);
  // The core's clock less this one's, so the countdown keeps the core's time.
  const offset = useRef(0);
  // Which time the dialog was opened; an answer for an earlier one is late.
  const session = useRef(0);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const needsClose = useRef(true);
  const isDismissing = useRef(false);
  // Whether Done could not stop new devices joining; then it closes the
  // dialog anyway, since each network closes by itself when its time is up.
  const [stopFailed, setStopFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A closed dialog's request must finish before a later dialog opens the
  // network, including when the first open is still waiting on a radio.
  const sequence = useCallback(<T,>(request: () => Promise<T>) => {
    const result = pending.current.then(request);
    pending.current = result.catch(() => undefined);
    return result;
  }, []);
  const close = useCallback(() => sequence(closePairing), [sequence]);

  const open = useCallback(async () => {
    if (isDismissing.current) return;
    const current = session.current;
    needsClose.current = true;
    setOpening(true);
    setProblem(undefined);
    try {
      let startedAt = Date.now();
      const opened = await sequence(() => {
        startedAt = Date.now();
        return coreJson<Opened>("/api/devices/pairing/open", {
          method: "POST",
          json: {},
        });
      });
      if (current !== session.current) {
        return;
      }
      offset.current = Date.parse(opened.since) - startedAt;
      setSince((first) => first ?? opened.since);
      setPairing(opened);
    } catch (error) {
      if (current === session.current) setProblem(openProblem(error));
    } finally {
      if (current === session.current) setOpening(false);
    }
  }, [sequence]);

  const stop = async () => {
    const current = session.current;
    setProblem(undefined);
    try {
      const closed = await close();
      if (current === session.current) setPairing(closed);
    } catch (error) {
      if (current === session.current) setProblem(deviceProblem(error));
    }
  };

  const dismiss = async () => {
    if (isDismissing.current) return;
    if (stopFailed) {
      props.onOpenChange(false);
      return;
    }
    isDismissing.current = true;
    const current = session.current;
    setProblem(undefined);
    try {
      await close();
      if (current === session.current) {
        needsClose.current = false;
        props.onOpenChange(false);
      }
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

  // Opening the dialog lets devices join; closing it stops them.
  useEffect(() => {
    if (!props.open) return;
    session.current += 1;
    isDismissing.current = false;
    setStopFailed(false);
    setSince(undefined);
    setPairing(undefined);
    void open();
    return () => {
      session.current += 1;
      if (needsClose.current) void close().catch(() => undefined);
    };
  }, [props.open, open, close]);

  useEffect(() => {
    if (!props.open) return;
    const current = session.current;
    return props.live.subscribe({
      message(message) {
        if (message.type === "pairing") setPairing(message.pairing);
      },
      refresh() {
        void coreJson<PairingInfo>("/api/devices/pairing")
          .then((next) => {
            if (current === session.current) setPairing(next);
          })
          .catch(() => undefined);
      },
    });
  }, [props.open, props.live]);

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
  const isOpen = secondsLeft > 0;

  const joined = since
    ? (pairing?.joined ?? []).filter(
        (each) => Date.parse(each.joinedAt) >= Date.parse(since),
      )
    : [];

  const save = async (
    device: DeviceInfo,
    changes: { name?: string | null; roomId?: string | null },
  ) => {
    setProblem(undefined);
    try {
      props.onChanged(await updateDevice(device.id, changes));
    } catch (error) {
      setProblem(deviceProblem(error));
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (isOpen) props.onOpenChange(true);
        else void dismiss();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add devices</DialogTitle>
          <DialogDescription>
            Switch a new device on, or reset one, and it shows up here as it
            joins. Then name it and choose its room.
          </DialogDescription>
        </DialogHeader>
        <p className="m-0 text-sm" aria-live="polite">
          {opening && !pairing
            ? "Getting ready…"
            : isOpen
              ? `New devices can join for ${countdown(secondsLeft)}.`
              : "New devices can no longer join."}
        </p>
        {joined.length > 0 ? (
          <ul className="m-0 flex max-h-80 list-none flex-col gap-4 overflow-y-auto p-0">
            {joined.map((each) => (
              <JoinedRow
                key={`${each.driver}:${each.key}`}
                joined={each}
                device={props.devices.find(
                  (device) => device.id === each.deviceId,
                )}
                rooms={props.rooms}
                onSave={save}
              />
            ))}
          </ul>
        ) : (
          isOpen && (
            <p className="m-0 flex items-center gap-3 text-sm text-muted-foreground">
              <KnotLoader className="size-7 shrink-0" />
              Looking for new devices…
            </p>
          )
        )}
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          {isOpen ? (
            <Button variant="outline" onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={opening}
              onClick={() => void open()}
            >
              Look again
            </Button>
          )}
          <Button onClick={() => void dismiss()}>
            {stopFailed ? "Close anyway" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JoinedRow(props: {
  joined: JoinedDevice;
  device?: DeviceInfo;
  rooms: readonly Room[];
  onSave: (
    device: DeviceInfo,
    changes: { name?: string | null; roomId?: string | null },
  ) => Promise<void>;
}) {
  const { joined, device } = props;
  const ready = joined.stage === "ready" && device;
  const working = joined.stage === "joined" || joined.stage === "interviewing";
  const detail = [
    device && joined.description !== device.name ? joined.description : null,
    stageText(joined),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-start gap-3">
      {ready ? (
        <DeviceIcon device={device} />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/12"
        >
          {working ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <CircleAlert className="size-4" />
          )}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {ready ? (
          <div className="flex items-center gap-2">
            <NameField
              device={device}
              onSave={(name) => void props.onSave(device, { name })}
            />
            <RoomPicker
              device={device}
              rooms={props.rooms}
              onChange={(roomId) => void props.onSave(device, { roomId })}
            />
          </div>
        ) : (
          // A device the home has goes by its name while it joins again.
          <span className="truncate text-sm font-medium">
            {device?.name ?? joined.description ?? "New device"}
          </span>
        )}
        <span className="text-[13px] font-medium text-muted-foreground">
          {detail}
        </span>
      </div>
    </li>
  );
}

// A device's name, saved when the field is left. Left empty, the device is
// named after its room again, and the field follows the name the core
// gives it while nobody is typing.
function NameField(props: {
  device: DeviceInfo;
  onSave: (name: string | null) => void;
}) {
  const { device } = props;
  const [draft, setDraft] = useState(device.name);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setDraft(device.name);
  }, [device.name, typing]);

  return (
    <Input
      aria-label={`Name for ${device.driverName}`}
      value={draft}
      maxLength={120}
      onFocus={() => setTyping(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setTyping(false);
        const name = draft.trim();
        if (name !== device.name) props.onSave(name || null);
        if (!name) setDraft(device.name);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className="h-8 min-w-0 flex-1"
    />
  );
}
