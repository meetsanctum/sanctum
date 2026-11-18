import type {
  DeviceInfo,
  DeviceType,
  JoinedDevice,
  Room,
} from "@meetsanctum/app-sdk";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, CircleAlert } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { Segments } from "./automations/fields";
import { productName } from "./brand";
import { coreJson } from "./core-fetch";
import {
  DeviceIcon,
  deviceProblem,
  RoomPicker,
  showAsOf,
} from "./device-parts";
import { KnotLoader } from "./knot-loader";

// The cards of Add devices, one for each device found, joining or added:
// what it is, and once it is ready its name, what it is shown as and its
// room, set right on the card. A card says how a device got on by its look:
// neutral while it waits or joins, green with a check once it is added or
// ready, red where it did not finish joining. Cards in a row are as tall as
// the tallest, and grow with their words rather than cut them off. A device
// added or ready for the first time while someone watches is greeted once: a
// warm light sweeps across its card, and a light's round glows as a bulb
// switching on.

/** What a card saves of its device. */
export type DeviceChanges = {
  name?: string | null;
  roomId?: string | null;
  shownAs?: DeviceType | null;
};

/** What the cards of a page can do, from Add devices. */
export type CardWork = {
  rooms: readonly Room[];
  onSave: (device: DeviceInfo, changes: DeviceChanges) => Promise<void>;
  // Makes a room of this name, answering its id.
  onAddRoom: (name: string) => Promise<string>;
  // Asks whether to remove a device, first.
  onRemove: (device: DeviceInfo) => void;
  // Whether a device is yet to be greeted, and that it was.
  isFresh: (id: string) => boolean;
  onGreeted: (id: string) => void;
};

/**
 * How far a device that joined has come, in words. One that is ready and
 * has nothing Sanctum can use says so: it is the household's to name and
 * place all the same.
 */
export function stageText(joined: JoinedDevice, device?: DeviceInfo) {
  switch (joined.stage) {
    case "joined":
      return "Joining…";
    case "interviewing":
      return "Setting up…";
    case "ready":
      if (device && device.capabilities.length === 0) {
        return `${productName} can't use this device`;
      }
      return joined.known ? "Joined again" : "Ready";
    case "unsupported":
      return `${productName} can't use this device`;
    case "failed":
      return "Device failed to join";
  }
}

type Tone = "neutral" | "success" | "error";

const tones: Record<Tone, string> = {
  neutral:
    "from-white/12 to-white/6 shadow-[inset_0_1px_0_rgb(255_255_255/0.1),inset_0_0_0_1px_rgb(255_255_255/0.12),0_16px_40px_rgb(0_0_0/0.24)]",
  success:
    "from-(--leaf)/20 to-(--leaf)/8 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),inset_0_0_0_1px_rgb(52_199_89/0.42),0_16px_40px_rgb(0_0_0/0.24)]",
  error:
    "from-(--ruby)/20 to-(--ruby)/8 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),inset_0_0_0_1px_rgb(255_59_48/0.45),0_16px_40px_rgb(0_0_0/0.24)]",
};

const rounds: Record<Tone, string> = {
  neutral: "bg-white/14",
  success: "bg-(--leaf)/24 shadow-[inset_0_0_0_1px_rgb(52_199_89/0.5)]",
  error:
    "bg-(--ruby)/24 text-(--ruby-on-carbon) shadow-[inset_0_0_0_1px_rgb(255_59_48/0.5)]",
};

/** A card in Add devices' grid, in the look of how its device got on. */
export function DeviceCard(props: {
  tone?: Tone;
  index?: number;
  label?: string;
  children: ReactNode;
}) {
  return (
    <li
      aria-label={props.label}
      // Each card rises in a little after the one before it.
      style={{ animationDelay: `${(props.index ?? 0) * 80}ms` }}
      className={cn(
        "relative flex min-h-55 flex-col items-center rounded-lg bg-linear-to-b px-4 pt-4.5 pb-4 text-center",
        "motion-safe:animate-in motion-safe:fill-mode-both motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-500 motion-reduce:animate-in motion-reduce:fill-mode-both motion-reduce:fade-in-0",
        tones[props.tone ?? "neutral"],
      )}
    >
      {props.children}
    </li>
  );
}

/**
 * A card's round: the device's icon, or what stands for it while it joins,
 * with a check on its edge once it is ready.
 */
export function CardRound(props: {
  tone?: Tone;
  // Read out where the check stands for words, such as "Ready".
  done?: string;
  // Glows once, as a bulb switching on.
  glows?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="relative shrink-0">
      <span
        aria-hidden="true"
        className={cn(
          "relative flex size-12 items-center justify-center overflow-hidden rounded-full [&_svg:not(.knot-loader)]:relative [&_svg:not(.knot-loader)]:size-5.5",
          rounds[props.tone ?? "neutral"],
        )}
      >
        {props.glows && <span className="add-devices-glow" />}
        {props.children}
      </span>
      {props.done && (
        <span
          role="img"
          aria-label={props.done}
          // Dark green under the White check, about 5 : 1.
          className="absolute -top-0.75 -right-1.25 flex size-5 items-center justify-center rounded-full bg-[#1f8039] text-white shadow-[0_0_0_2.5px_rgb(41_48_43)]"
        >
          <Check aria-hidden="true" strokeWidth={3} className="size-3" />
        </span>
      )}
    </span>
  );
}

/** The device's own icon, in a card's round. */
export const TypeIcon = (props: {
  device?: DeviceInfo;
  type?: string | null;
}) => <DeviceIcon device={props.device} type={props.type} bare />;

/** What it is, or what is going on with it, under its name. */
export function CardLine(props: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "mt-1.5 text-[13px] leading-[18px] font-medium text-(--silver)",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** What a card does, at its foot. */
export function CardFoot(props: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mt-auto flex w-full flex-wrap justify-center gap-1.5 pt-3",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

// A device added or ready, named and placed right here: green with a check.
export function ReadyCard(props: {
  device: DeviceInfo;
  // What it is, or that it joined again.
  line: string | null;
  done: string;
  // Whether it is new to the home, to be greeted as it appears.
  isNew: boolean;
  work: CardWork;
  index?: number;
}) {
  const { device, work } = props;
  // Decided as it appears, so that the greeting runs once and to its end.
  const [greets] = useState(() => props.isNew && work.isFresh(device.id));
  useEffect(() => {
    if (greets) work.onGreeted(device.id);
  }, [greets, work, device.id]);
  const isLight = device.capabilities.some((each) => each.kind === "light");
  return (
    <DeviceCard tone="success" index={props.index}>
      {greets && <span aria-hidden="true" className="add-devices-sweep" />}
      <CardRound tone="success" done={props.done} glows={greets && isLight}>
        <TypeIcon device={device} />
      </CardRound>
      <NameField
        device={device}
        onSave={(name) => void work.onSave(device, { name })}
      />
      {props.line && <CardLine className="mt-2">{props.line}</CardLine>}
      <CardFoot className="flex-col flex-nowrap items-stretch gap-2">
        <ShowAsChoice device={device} work={work} />
        <RoomChoice
          device={device}
          work={work}
          beside={device.identify && <BlinkButton device={device} />}
        />
      </CardFoot>
    </DeviceCard>
  );
}

// Blink: has the device show itself, as a light blinks, so a person sees
// which one it is. It says so while the device blinks, and why where it
// couldn't.
function BlinkButton(props: { device: DeviceInfo }) {
  const [blinking, setBlinking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const blink = async () => {
    setProblem(undefined);
    setBlinking(true);
    try {
      await coreJson("/api/devices/identify", {
        method: "POST",
        json: { id: props.device.id },
      });
      // About as long as a device takes to blink and settle.
      timer.current = window.setTimeout(() => setBlinking(false), 2_500);
    } catch (error) {
      setBlinking(false);
      setProblem(deviceProblem(error));
    }
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={blinking}
        aria-label={`Blink ${props.device.name}`}
        onClick={() => void blink()}
      >
        {blinking ? "Blinking…" : "Blink"}
      </Button>
      {problem && (
        <p
          role="alert"
          className="m-0 basis-full text-xs text-(--ruby-on-carbon)"
        >
          {problem}
        </p>
      )}
    </>
  );
}

// A device Sanctum can't use: named and placed all the same, or removed.
function UnusableCard(props: {
  device: DeviceInfo;
  work: CardWork;
  index?: number;
}) {
  const { device, work } = props;
  return (
    <DeviceCard index={props.index}>
      <CardRound>
        <TypeIcon device={device} />
      </CardRound>
      <NameField
        device={device}
        onSave={(name) => void work.onSave(device, { name })}
      />
      <CardLine className="mt-2">
        {`${productName} can't use this device. Keep it in a room, or remove it.`}
      </CardLine>
      <CardFoot className="flex-col flex-nowrap items-stretch gap-2">
        <ShowAsChoice device={device} work={work} />
        <RoomChoice
          device={device}
          work={work}
          beside={
            <Button
              variant="outline"
              size="sm"
              aria-label={`Remove ${device.name}`}
              onClick={() => work.onRemove(device)}
            >
              Remove
            </Button>
          }
        />
      </CardFoot>
    </DeviceCard>
  );
}

// What a device is shown as, where its type may be shown as another: the
// choices side by side under their label, the one in effect chosen.
function ShowAsChoice(props: { device: DeviceInfo; work: CardWork }) {
  const id = useId();
  const showAs = showAsOf(props.device);
  if (!showAs) return null;
  return (
    <div className="flex flex-col gap-1 text-start">
      <span id={id} className="text-xs font-medium text-(--silver)">
        Show as
      </span>
      <Segments
        label={`${props.device.name}: show as`}
        options={showAs.options.map((option) => ({
          value: option.id,
          label: option.title,
        }))}
        selected={showAs.current}
        wraps
        onSelect={(value) =>
          void props.work.onSave(props.device, {
            shownAs: showAs.choice(value),
          })
        }
      />
    </div>
  );
}

// Which room a device is in, with New room… at the end of the menu, which
// makes one right here: its name in a labelled field, and Add room puts the
// device in it. Escape, or leaving it empty, goes back to the menu.
function RoomChoice(props: {
  device: DeviceInfo;
  work: CardWork;
  // Beside the menu, such as Remove.
  beside?: ReactNode;
}) {
  const { device, work } = props;
  const id = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted || working) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const roomId = await work.onAddRoom(wanted);
      await work.onSave(device, { roomId });
      setNaming(false);
      setName("");
    } catch (error) {
      setProblem(deviceProblem(error));
    } finally {
      setWorking(false);
    }
  };

  if (naming) {
    return (
      <form
        data-slot="add-devices-new-room"
        onSubmit={add}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setNaming(false);
            setName("");
          }
        }}
        className="flex flex-col gap-1 text-start"
      >
        <label htmlFor={id} className="text-xs font-medium text-(--silver)">
          New room
        </label>
        <div className="flex gap-1.5">
          <Input
            id={id}
            ref={field}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-0 flex-1 bg-black/14 pointer-coarse:h-11"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={working || !name.trim()}
          >
            {working ? "Adding…" : "Add room"}
          </Button>
        </div>
        {problem && (
          <p role="alert" className="m-0 text-xs text-(--ruby-on-carbon)">
            {problem}
          </p>
        )}
      </form>
    );
  }
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      <RoomPicker
        device={device}
        rooms={work.rooms}
        onChange={(roomId) => void work.onSave(device, { roomId })}
        onNewRoom={() => setNaming(true)}
      />
      {props.beside}
    </div>
  );
}

// A device that joined: how far it has come while it joins, then the card
// of a ready device; red where it did not finish joining. One Sanctum
// cannot use is named and placed all the same, in the neutral look.
export function JoinedCard(props: {
  joined: JoinedDevice;
  device?: DeviceInfo;
  work: CardWork;
  index?: number;
}) {
  const { joined, device } = props;
  const words = stageText(joined, device);
  if (joined.stage === "ready" && device) {
    if (device.capabilities.length === 0) {
      return (
        <UnusableCard device={device} work={props.work} index={props.index} />
      );
    }
    return (
      <ReadyCard
        device={device}
        line={joined.known ? "Joined again" : joined.description}
        done={words}
        isNew={!joined.known}
        work={props.work}
        index={props.index}
      />
    );
  }
  if (joined.stage === "failed") {
    return (
      <DeviceCard tone="error" index={props.index}>
        <CardRound tone="error">
          <CircleAlert />
        </CardRound>
        <span className="mt-3.5 text-[15.5px] font-semibold">{words}</span>
        <CardLine>Reset it, then start again.</CardLine>
      </DeviceCard>
    );
  }
  const working = joined.stage === "joined" || joined.stage === "interviewing";
  return (
    <DeviceCard index={props.index}>
      <CardRound>
        {working ? (
          <KnotLoader className="size-7" />
        ) : (
          <TypeIcon device={device} />
        )}
      </CardRound>
      {/* A device the home has goes by its name while it joins again. */}
      <span className="mt-3.5 text-[15.5px] font-semibold">
        {device?.name ?? joined.description ?? "New device"}
      </span>
      <CardLine>{working ? words : `${words}.`}</CardLine>
    </DeviceCard>
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
      className="mt-3 h-8 w-full bg-black/14 text-center text-sm font-semibold pointer-coarse:h-11"
    />
  );
}
