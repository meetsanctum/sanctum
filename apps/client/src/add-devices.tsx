import type {
  AddResult,
  AppInfo,
  DeviceInfo,
  FoundDevice,
  PairingInfo,
  Room,
} from "@meetsanctum/app-sdk";
import { Button, type LiveFeed } from "@meetsanctum/ui-sdk";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { JoinedRow, ReadyRow, type DeviceChanges } from "./add-devices-rows";
import { productName } from "./brand";
import { Section } from "./components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { DeviceIcon, deviceProblem, updateDevice } from "./device-parts";
import { QuestionField, type Refused } from "./device-questions";
import { KnotLoader } from "./knot-loader";
import { addDevicesHint, type ServiceNotSetUp } from "./system-status";

// Adding devices, for everyone, whatever the radio: the devices drivers
// found, as on the home's network, and the core's pairing flow. Found devices
// come first, each with an Add that asks in place what its driver needs, such
// as its key, a refused answer saying why under its field. Then the radios
// that let devices join: opening the dialog lets new devices join for four
// minutes, with the time left and a way to stop, and each device that joins
// shows as it gets on. A device added or ready is named and put in a room
// right here. Closing the dialog stops new devices joining and empties every
// answer typed in it.

type Opened = PairingInfo & { since: string };
/** Minutes and seconds, as a countdown shows them: 3:52. */
export function countdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Names in a sentence: Zigbee, Zigbee or Thread. */
function either(names: readonly string[]) {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

function openProblem(error: unknown) {
  if (error instanceof CoreError && error.status >= 500) {
    return `${productName} could not let devices join. Try again.`;
  }
  return deviceProblem(error);
}

function addProblem(error: unknown, appName: string | null) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "unavailable":
        return `${appName ?? "Its app"} isn't running, so it can't add it now.`;
      case "timeout":
        return "It didn't answer in time. Check it's switched on, then try again.";
      case "not_found":
        return "It's no longer on your network.";
      case "app_failed":
        return `${appName ?? "Its app"} couldn't add it. Try again.`;
    }
  }
  return deviceProblem(error);
}

const foundKey = (found: { driver: string; key: string }) =>
  `${found.driver}\u0000${found.key}`;

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
  // let devices join. An older core says neither.
  adding?: PairingInfo;
  // The services the home never set up, to say what to plug in.
  notSetUp?: readonly ServiceNotSetUp[];
  live: LiveFeed;
  onChanged: (device: DeviceInfo) => void;
}) {
  const ids = useId();
  const [pairing, setPairing] = useState<PairingInfo>();
  // What joined from the first time this dialog opened the network.
  const [since, setSince] = useState<string>();
  const [problem, setProblem] = useState<string>();
  // Whether no app could let devices join when the dialog opened.
  const [unavailable, setUnavailable] = useState(false);
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
  // The found devices the dialog shows, in the order it first showed them,
  // and those added here, which stay to be named and placed.
  const [shown, setShown] = useState<FoundDevice[]>([]);
  const [added, setAdded] = useState<Record<string, DeviceInfo>>({});
  const [pendingAdds, setPendingAdds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const saveAttempts = useRef(new Map<string, symbol>());

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
    setUnavailable(false);
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
      if (current !== session.current) return;
      if (error instanceof CoreError && error.code === "unavailable") {
        setUnavailable(true);
      } else {
        setProblem(openProblem(error));
      }
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
    setShown([]);
    setAdded({});
    setPendingAdds(new Set());
    void open();
    return () => {
      session.current += 1;
      if (needsClose.current) void close().catch(() => undefined);
    };
  }, [props.open, open, close]);

  // A save can finish after the dialog closes, so keep following live devices.
  useEffect(() => {
    const current = session.current;
    // A read the live feed or a later read has overtaken is out of date.
    let revision = 0;
    const received = (next: PairingInfo) => {
      setPairing(next);
      if (next.drivers?.length) setUnavailable(false);
    };
    return props.live.subscribe({
      message(message) {
        if (message.type === "device") saveAttempts.current.delete(message.id);
        if (!props.open || message.type !== "pairing") return;
        revision += 1;
        received(message.pairing);
      },
      refresh() {
        if (!props.open) return;
        const requested = ++revision;
        void coreJson<PairingInfo>("/api/devices/pairing")
          .then((next) => {
            if (current === session.current && requested === revision) {
              received(next);
            }
          })
          .catch(() => undefined);
      },
    });
  }, [props.open, props.live]);

  // Found devices keep their place: one that goes is dropped, unless it was
  // added here or its Add is still waiting, and one that comes goes last.
  const found = props.adding?.found ?? pairing?.found;
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
  const isOpen = secondsLeft > 0;

  const joined = since
    ? (pairing?.joined ?? []).filter(
        (each) => Date.parse(each.joinedAt) >= Date.parse(since),
      )
    : [];

  const appName = (id: string) =>
    props.apps.find((app) => app.id === id)?.name ?? null;
  // The apps that let devices join, or nothing known of them from an older
  // core, which lets them join all the same.
  const drivers = pairing?.drivers ?? props.adding?.drivers;
  const radios = (drivers ?? []).flatMap((id) => appName(id) ?? []);
  const pairs = !unavailable && (drivers === undefined || drivers.length > 0);
  const cannotAdd = !pairs && !opening && shown.length === 0;
  // What to plug in, where that is all that is missing; else that nothing
  // can add any.
  const hint = cannotAdd
    ? addDevicesHint(props.apps, props.notSetUp)
    : undefined;
  const nothing =
    cannotAdd && !hint ? "No app that adds devices is running." : undefined;

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

  const status =
    opening && !pairing
      ? "Getting ready…"
      : isOpen
        ? "Looking for new devices…"
        : "New devices can no longer join";

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
            Switch a new device on, or reset one, and it shows up here. Then
            name it and choose its room.
          </DialogDescription>
        </DialogHeader>
        {shown.length > 0 && (
          <Section
            id={`${ids}-found`}
            level={3}
            title="Found on your network"
            hint={`${shown.length} ${shown.length === 1 ? "device" : "devices"}`}
          >
            <ul className="m-0 flex max-h-72 list-none flex-col gap-4 overflow-y-auto p-0">
              {shown.map((each) => {
                const key = foundKey(each);
                const device = Object.hasOwn(added, key)
                  ? (props.devices.find(
                      (device) => device.id === added[key]!.id,
                    ) ?? added[key])
                  : undefined;
                return device ? (
                  <ReadyRow
                    key={key}
                    device={device}
                    detail="Ready"
                    rooms={props.rooms}
                    onSave={save}
                  />
                ) : (
                  <FoundRow
                    key={key}
                    found={each}
                    appName={appName(each.driver)}
                    onWorkingChange={(isWorking) => {
                      setPendingAdds((before) => {
                        const next = new Set(before);
                        if (isWorking) next.add(key);
                        else next.delete(key);
                        return next;
                      });
                    }}
                    onAdded={(device) => {
                      setAdded((before) => ({ ...before, [key]: device }));
                      props.onChanged(device);
                    }}
                  />
                );
              })}
            </ul>
          </Section>
        )}
        {pairs && (
          <Section
            id={`${ids}-joining`}
            level={3}
            title={radios.length > 0 ? radios.join(" and ") : "New devices"}
            hint={isOpen ? `${countdown(secondsLeft)} left` : undefined}
          >
            <ul className="m-0 flex max-h-80 list-none flex-col gap-4 overflow-y-auto p-0">
              <li className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center"
                >
                  {isOpen && <KnotLoader className="size-7" />}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium" aria-live="polite">
                    {status}
                  </span>
                  <span className="text-[13px] font-medium text-muted-foreground">
                    {`Put a ${radios.length > 0 ? either(radios) : "new"} device in pairing mode`}
                  </span>
                </div>
                {isOpen ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void stop()}
                  >
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={opening}
                    onClick={() => void open()}
                  >
                    Look again
                  </Button>
                )}
              </li>
              {joined.map((each) => (
                <JoinedRow
                  key={foundKey(each)}
                  joined={each}
                  device={props.devices.find(
                    (device) => device.id === each.deviceId,
                  )}
                  rooms={props.rooms}
                  onSave={save}
                />
              ))}
            </ul>
          </Section>
        )}
        {hint && !problem && (
          <p className="m-0 text-sm text-muted-foreground">{hint}</p>
        )}
        {/* There before the hint is, so it is heard when looking ends. */}
        <p role="status" className="sr-only">
          {problem ? "" : hint}
        </p>
        {(problem ?? nothing) && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem ?? nothing}
          </p>
        )}
        <DialogFooter>
          <Button onClick={() => void dismiss()}>
            {stopFailed ? "Close anyway" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A device someone could add. Add sends at once what needs nothing asked;
// otherwise it opens the driver's questions under the row, and the answers
// go once, in the body of one request. The fields empty once it's added or
// the dialog closes.
function FoundRow(props: {
  found: FoundDevice;
  appName: string | null;
  onWorkingChange: (isWorking: boolean) => void;
  onAdded: (device: DeviceInfo) => void;
}) {
  const ids = useId();
  const { found } = props;
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Refused>();
  const [failure, setFailure] = useState<string>();
  const [working, setWorking] = useState(false);
  // An answer that arrives once the row is gone goes nowhere.
  const isShown = useRef(true);
  useEffect(() => {
    isShown.current = true;
    return () => {
      isShown.current = false;
    };
  }, []);

  const answerTo = (id: string) =>
    Object.hasOwn(answers, id) ? answers[id]! : "";
  const isAsking = asking && found.asks.length > 0;
  const complete = found.asks.every((question) => answerTo(question.id) !== "");

  const add = async () => {
    if (working) return;
    setWorking(true);
    props.onWorkingChange(true);
    setRefused(undefined);
    setFailure(undefined);
    try {
      const result = await coreJson<AddResult>("/api/devices/add", {
        method: "POST",
        json: {
          driver: found.driver,
          key: found.key,
          answers: Object.fromEntries(
            found.asks.map((question) => [question.id, answerTo(question.id)]),
          ),
        },
      });
      if (!isShown.current) return;
      if ("refused" in result) {
        setRefused(result.refused);
        return;
      }
      setAnswers({});
      props.onAdded(result.added);
    } catch (error) {
      if (!isShown.current) return;
      setFailure(addProblem(error, props.appName));
    } finally {
      if (isShown.current) {
        setWorking(false);
        props.onWorkingChange(false);
      }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete) void add();
  };

  const label = `Add ${found.name}`;
  const detail = [props.appName, isAsking ? null : found.description]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <DeviceIcon type={found.type} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{found.name}</span>
          {detail && (
            <span className="truncate text-[13px] font-medium text-muted-foreground">
              {detail}
            </span>
          )}
        </div>
        {!isAsking && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={working}
            aria-label={label}
            onClick={() => {
              if (found.asks.length > 0) setAsking(true);
              else void add();
            }}
          >
            {working ? "Adding…" : "Add"}
          </Button>
        )}
      </div>
      {isAsking && (
        <form onSubmit={submit} className="flex flex-col gap-2.5 ps-11">
          {found.asks.map((question, index) => (
            <QuestionField
              key={question.id}
              id={`${ids}-${question.id}`}
              question={question}
              value={answerTo(question.id)}
              refused={refused}
              autoFocus={index === 0}
              onChange={(value) =>
                setAnswers((before) => ({ ...before, [question.id]: value }))
              }
              beside={
                index === found.asks.length - 1 && (
                  <Button
                    type="submit"
                    variant="outline"
                    className="shrink-0"
                    disabled={working || !complete}
                    aria-label={label}
                  >
                    {working ? "Adding…" : "Add"}
                  </Button>
                )
              }
            />
          ))}
        </form>
      )}
      {failure && (
        <p role="alert" className="m-0 ps-11 text-sm text-destructive">
          {failure}
        </p>
      )}
    </li>
  );
}
