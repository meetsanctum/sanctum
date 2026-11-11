import type { ActionOutput } from "@meetsanctum/app-sdk";
import {
  Button,
  icons,
  pressGroups,
  pressLabel,
  pressTitle,
  useAppClient,
  type DevicePageProps,
} from "@meetsanctum/ui-sdk";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { choosePress, listPresses } from "../presses/actions.js";
import type { PressChoice, PressPlace } from "../presses/presses.js";
import { ChoicePage } from "./press-choice";
import { defaultsNote, describeChoice } from "./press-words";
import { useMoodsApp } from "./state";
import { WhichLightsPage } from "./which-lights";

// The Presses page Moods adds to a remote's detail: each press its driver
// declares, by button where the remote has several, with what it does by
// choice or by default, and a press's own page to choose that, which applies
// at once, with a page for which lights. Find a press captures the remote's
// presses while someone presses one, so they switch nothing meanwhile, and
// rings the press it heard.

type Listing = ActionOutput<typeof listPresses>;

// What presses need: seeing them, and keeping the automations they run.
const pressPermissions = ["devices.read:button", "workflows.manage"];

/** Moods' page in a remote's detail. */
export function PressesPage(props: DevicePageProps) {
  const { device } = props;
  const client = useAppClient();
  const { places, moods, devices } = useMoodsApp();
  const [listing, setListing] = useState<Listing>();
  // The press whose page is open, and whether its Which lights is.
  const [opened, setOpened] = useState<string | null>(null);
  const [isWhich, setIsWhich] = useState(false);
  // Which lights a press's verbs are for while it does something else.
  const [draftPlace, setDraftPlace] = useState<PressPlace | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const saving = useRef(false);
  const captureEndsAt = useRef(0);
  const [problem, setProblem] = useState<string | null>(null);
  // While finding a press: the one it heard last, if any.
  const [finding, setFinding] = useState<{ heard: string | null } | null>(null);
  const capture = useRef<{ stop(): Promise<void> } | null>(null);
  const loadVersion = useRef(0);
  const remoteConfig = JSON.stringify([device.roomId, device.capabilities]);

  useEffect(() => {
    let current = true;
    const load = () => {
      const version = ++loadVersion.current;
      client
        .call<typeof listPresses>("moods.presses", { device: device.id })
        .then((loaded) => {
          if (!current || version !== loadVersion.current) return;
          setListing(loaded);
          setLoadProblem(null);
          setOpened((action) =>
            loaded.presses.some((each) => each.action === action)
              ? action
              : null,
          );
        })
        .catch(() => {
          if (current && version === loadVersion.current) {
            setLoadProblem("Couldn't read the presses.");
          }
        });
    };
    load();
    const unsubscribe = client.subscribe({ refresh: load });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client, device.id, remoteConfig]);

  const stopFinding = useCallback(async () => {
    const current = capture.current;
    if (!current) return true;
    try {
      await current.stop();
      if (capture.current === current) {
        capture.current = null;
        setFinding(null);
        setProblem(null);
      }
      return true;
    } catch {
      setProblem("Couldn't stop listening. Try Stop again.");
      return false;
    }
  }, []);
  // Leaving the page or the detail stops listening.
  useEffect(
    () => () => {
      if (capture.current)
        stopAfterLeaving(capture.current, captureEndsAt.current);
    },
    [],
  );

  const find = () => {
    setProblem(null);
    setFinding({ heard: null });
    // Captures expire at the core after at most five minutes.
    captureEndsAt.current = performance.now() + 5 * 60_000;
    const current = client.capturePresses(device.id, {
      press: (press) => {
        if (capture.current === current) setFinding({ heard: press.action });
      },
      ended: (reason) => {
        // Start may finish after Stop or unmount. Keep this handle in the
        // callback so even a late failed release can still be retried.
        stopAfterLeaving(current, performance.now() + 5 * 60_000);
        if (capture.current !== current) return;
        capture.current = null;
        setFinding(null);
        if (reason === "failed") {
          setProblem("Couldn't listen for the remote. Try again.");
        }
      },
    });
    capture.current = current;
  };

  const choose = async (action: string, choice: PressChoice | null) => {
    if (saving.current) return false;
    saving.current = true;
    setIsSaving(true);
    setProblem(null);
    ++loadVersion.current;
    try {
      setListing(
        await client.call<typeof choosePress>("moods.choosePress", {
          device: device.id,
          action,
          choice,
        }),
      );
      setLoadProblem(null);
      ++loadVersion.current;
      return true;
    } catch {
      setProblem("Couldn't change that press. Try again.");
      return false;
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  const groups = pressGroups(listing?.presses.map((each) => each.action) ?? []);
  const lightsMoods = moods.moods ?? [];

  // Presses start on, so a remote works from its first press. Once someone
  // has switched them off in Moods settings, choosing them asks again.
  const off = pressPermissions.filter(
    (id) => !client.app.permissions.includes(id),
  );
  if (off.length > 0) {
    return (
      <section aria-label="What its presses do" className="flex flex-col gap-4">
        <p className="m-0 px-1 text-[15px] leading-5 text-(--silver)">
          To run a mood or switch lights with this remote, Moods needs to{" "}
          {off.includes("devices.read:button")
            ? "see its presses"
            : "keep the automations its presses run"}
          .
        </p>
        <div>
          <Button
            variant="outline"
            size="lg"
            onClick={() => void client.ask(off).catch(() => undefined)}
          >
            <icons.CircleDot aria-hidden="true" />
            Choose presses
          </Button>
        </div>
      </section>
    );
  }

  if (opened !== null && listing) {
    const press = listing.presses.find((each) => each.action === opened);
    const choice: PressChoice = press?.choice ??
      press?.default ?? { kind: "nothing" };
    // The verbs are for the lights the press is for, or else for the ones
    // last picked, the remote's room or all lights.
    const place: PressPlace =
      choice.kind === "lights"
        ? choice.place
        : (draftPlace ??
          (device.roomId
            ? { kind: "room", id: device.roomId }
            : { kind: "home" }));
    const title = pressTitle(opened, groups);
    const close = () => {
      setOpened(null);
      setIsWhich(false);
      setDraftPlace(null);
    };
    if (isWhich) {
      return (
        <WhichLightsPage
          device={device}
          back={title}
          place={place}
          places={places}
          devices={devices}
          doing={
            choice.kind === "lights"
              ? describeChoice(choice, places, devices, lightsMoods)
              : "Choose what the press does with them on its page"
          }
          dims={choice.kind === "lights" && dims.has(choice.to)}
          isSaving={isSaving}
          problem={problem ?? loadProblem}
          onBack={() => setIsWhich(false)}
          onPlace={async (next) => {
            if (
              choice.kind === "lights" &&
              !(await choose(opened, { ...choice, place: next }))
            )
              return false;
            setDraftPlace(next);
            return true;
          }}
        />
      );
    }
    return (
      <ChoicePage
        device={device}
        title={title}
        hold={press?.hold ?? false}
        choice={choice}
        place={place}
        places={places}
        devices={devices}
        moods={lightsMoods}
        problem={problem ?? loadProblem}
        isSaving={isSaving}
        onBack={close}
        onChoose={(next) => void choose(opened, next)}
        onWhichLights={() => setIsWhich(true)}
      />
    );
  }

  const heard = finding?.heard ?? null;
  const describe = (each: Listing["presses"][number]) =>
    describeChoice(each.choice ?? each.default, places, devices, lightsMoods);
  const open = (action: string) => {
    void stopFinding().then((stopped) => {
      if (stopped) setOpened(action);
    });
  };
  return (
    <section aria-label="What its presses do" className="flex flex-col gap-4">
      {finding && (
        <div role="status" className="flex items-center gap-4 px-1">
          <icons.CircleDot
            aria-hidden="true"
            className="size-8 shrink-0 text-white/65 motion-safe:animate-pulse"
          />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[17px] leading-[22px]">
              {heard
                ? `That was ${heardPhrase(heard, groups)}`
                : "Press a button on the remote"}
            </p>
            <p className="m-0 text-[15px] leading-5 text-(--silver)">
              {heard
                ? "Choose it below, or press another."
                : "While you're choosing, its presses switch nothing."}
            </p>
          </div>
          <Button
            variant="outline"
            size="lg"
            onClick={() => void stopFinding()}
          >
            Stop
          </Button>
        </div>
      )}
      {groups.map((group, index) => {
        const id = `presses-${index}`;
        return (
          <section
            key={group.button ?? "presses"}
            aria-labelledby={id}
            className="flex flex-col gap-2"
          >
            <h2
              id={id}
              className="m-0 px-1 text-[13px] leading-[18px] font-medium text-(--silver)"
            >
              {group.button ?? "When it's pressed"}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {group.presses.map(({ action, label }) => {
                const press = listing!.presses.find(
                  (each) => each.action === action,
                )!;
                return (
                  <li key={action}>
                    <Row
                      title={label}
                      detail={describe(press)}
                      heard={heard === action}
                      onClick={() => open(action)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {listing && (
        <p className="m-0 px-1 text-[15px] leading-5 text-(--silver)">
          {defaultsNote(
            listing.defaults,
            places,
            listing.presses.some((each) => each.hold),
          )}
        </p>
      )}
      {(problem ?? loadProblem) && (
        <p className="m-0 px-1 text-[13px] font-medium text-(--danger)">
          {problem ?? loadProblem}
        </p>
      )}
      {!finding && listing && (
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="outline" size="lg" onClick={find}>
            <icons.CircleDot aria-hidden="true" />
            Find a press
          </Button>
          <p className="m-0 text-[15px] leading-5 text-(--silver)">
            Not sure which is which? Press it on the remote.
          </p>
        </div>
      )}
    </section>
  );
}

// What brightens or dims a press's lights.
const dims = new Set([
  "brighter",
  "dimmer",
  "brightenWhileHeld",
  "dimWhileHeld",
  "brightenOrDimWhileHeld",
]);

// The press Find a press heard, as "That was …" goes on: "a double press",
// or on a remote with several buttons "the up button's hold".
function heardPhrase(action: string, groups: ReturnType<typeof pressGroups>) {
  for (const group of groups) {
    const press = group.presses.find((each) => each.action === action);
    if (!press) continue;
    const what = press.label.toLowerCase();
    if (!group.button) return `a ${what}`;
    const button = group.button.toLowerCase();
    return /^button \d/.test(button)
      ? `${group.button}'s ${what}`
      : `the ${button}'s ${what}`;
  }
  return `a ${pressLabel(action).toLowerCase()}`;
}

// A closing detail cannot offer Stop again. Retry transient failures until
// the core's capture deadline, after which presses are released anyway.
function stopAfterLeaving(capture: { stop(): Promise<void> }, until: number) {
  void capture.stop().catch(() => {
    if (performance.now() < until) {
      setTimeout(() => stopAfterLeaving(capture, until), 5_000);
    }
  });
}

function Row(props: {
  title: string;
  detail: ReactNode;
  heard?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="option"
      size="option"
      type="button"
      onClick={props.onClick}
      data-heard={props.heard ? "" : undefined}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[17px] leading-[22px]">{props.title}</span>
        <span className="truncate text-[15px] leading-5 text-(--silver)">
          {props.detail}
        </span>
      </span>
      {props.heard && (
        <span className="shrink-0 rounded-sm bg-white px-2 py-0.5 text-[13px] leading-[18px] font-medium text-(--carbon)">
          Just pressed
        </span>
      )}
      <icons.ChevronRight
        aria-hidden="true"
        className="size-[18px] shrink-0 text-(--pewter)"
      />
    </Button>
  );
}
