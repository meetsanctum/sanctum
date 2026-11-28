import {
  Button,
  PageSection,
  Problem,
  Slider,
  Switch,
  useAppClient,
  type DevicePageProps,
} from "@meetsanctum/ui-sdk";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ChangeRingAction, SpeakerAction } from "../page";
import { ringColourDistance } from "../ring-colour";
import type { Ring, SpeakerChange, SpeakerState } from "../speaker";

// A smart speaker's own part on ESPHome's page: Ring, how its ring looks.
// Its microphones are the shell's. The ring also shows what the speaker is
// doing, so the page reads it again every few seconds while it shows.

/** The ring's colours, the first the speaker's own. */
const ringColours = [
  { name: "Sky blue", hex: "#18bbf2" },
  { name: "Warm white", hex: "#ffd9a8" },
  { name: "Green", hex: "#30d158" },
  { name: "Orange", hex: "#ff9f0a" },
  { name: "Pink", hex: "#ff4d6a" },
  { name: "Purple", hex: "#c468f5" },
] as const;

const readEveryMs = 5_000;

/** The colour among the ring's that a colour is closest to, if it's close. */
export function ringColourOf(hex: string) {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const colour of ringColours) {
    const distance = ringColourDistance(hex, colour.hex);
    if (distance < bestDistance) {
      best = colour.hex;
      bestDistance = distance;
    }
  }
  // Within a few steps per channel, as the speaker rounds what it's given.
  return bestDistance <= 12 ? best : null;
}

function SwitchRow(props: {
  id: string;
  label: string;
  detail: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-13 items-center justify-between gap-3 px-2.5 text-[15px] leading-5">
      <label htmlFor={props.id} className="flex min-w-0 flex-col">
        <span>{props.label}</span>
        <span className="flex items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
          {props.detail}
        </span>
      </label>
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </div>
  );
}

function ColourChoice(props: {
  value: string | null;
  disabled: boolean;
  busy: boolean;
  onChange: (hex: string) => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusable = props.value ?? ringColours[0].hex;
  const onKeyDown = (event: React.KeyboardEvent) => {
    const by =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (by === 0) return;
    event.preventDefault();
    if (props.disabled || props.busy) return;
    const at = ringColours.findIndex(
      ({ hex }) => buttons.current.get(hex) === event.target,
    );
    if (at < 0) return;
    const next =
      ringColours[(at + by + ringColours.length) % ringColours.length]!.hex;
    props.onChange(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div className="flex min-h-13 items-center justify-between gap-3 px-2.5 text-[15px] leading-5">
      <span id="ring-colour">Colour</span>
      <div
        role="radiogroup"
        aria-labelledby="ring-colour"
        onKeyDown={onKeyDown}
        className="flex flex-wrap justify-end gap-1.5"
      >
        {ringColours.map((colour) => (
          <Button
            key={colour.hex}
            ref={(element) => {
              if (element) buttons.current.set(colour.hex, element);
              else buttons.current.delete(colour.hex);
            }}
            variant="tile"
            size="icon-lg"
            type="button"
            role="radio"
            aria-checked={colour.hex === props.value}
            aria-label={colour.name}
            tabIndex={colour.hex === focusable ? 0 : -1}
            disabled={props.disabled}
            aria-disabled={props.busy || undefined}
            onClick={() => {
              if (!props.busy) props.onChange(colour.hex);
            }}
          >
            <span
              aria-hidden="true"
              className="size-6 rounded-sm"
              style={{ background: colour.hex }}
            />
          </Button>
        ))}
      </div>
    </div>
  );
}

function BrightnessRow(props: {
  value: number;
  disabled: boolean;
  onChange: (brightness: number) => void;
}) {
  const labelId = useId();
  const dragging = useRef(false);
  const [sliding, setSliding] = useState<number | null>(null);
  const shown = sliding ?? props.value;
  function stopDragging() {
    dragging.current = false;
    setSliding(null);
  }
  return (
    <div className="flex min-h-13 items-center gap-4 px-2.5 text-[15px] leading-5">
      <span id={labelId} className="w-22 shrink-0">
        Brightness
      </span>
      <Slider
        ref={(root) => {
          // The shared slider puts its accessible role on the thumb.
          root
            ?.querySelector('[role="slider"]')
            ?.setAttribute("aria-labelledby", labelId);
        }}
        min={20}
        max={100}
        step={1}
        value={[shown]}
        disabled={props.disabled}
        onPointerDown={() => {
          dragging.current = !props.disabled;
        }}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onValueChange={([value]) => {
          if (dragging.current) setSliding(value ?? null);
        }}
        onValueCommit={([value]) => {
          setSliding(null);
          if (value !== undefined) props.onChange(value);
        }}
      />
      <span
        aria-hidden="true"
        className="w-11 shrink-0 text-right text-muted-foreground tabular-nums"
      >
        {shown} %
      </span>
    </div>
  );
}

export function SpeakerCards(props: DevicePageProps) {
  const { device } = props;
  const client = useAppClient();
  const [speaker, setSpeaker] = useState<SpeakerState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const reads = useRef(0);
  const pending = useRef(false);

  const read = useCallback(async () => {
    const read = ++reads.current;
    try {
      const now = await client.call<SpeakerAction>("esphome.speaker", {
        device: device.id,
      });
      if (read === reads.current) setSpeaker(now);
    } catch {
      // What it showed stays until a read goes through.
    }
  }, [client, device.id]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!pending.current && document.visibilityState === "visible")
        await read();
      if (current) timer = setTimeout(refresh, readEveryMs);
    }
    const initial = pending.current ? Promise.resolve() : read();
    void initial.then(() => {
      if (current) timer = setTimeout(refresh, readEveryMs);
    });
    return () => {
      current = false;
      reads.current += 1;
      clearTimeout(timer);
    };
  }, [read, device.availability]);

  async function change(next: SpeakerChange, shown: SpeakerState) {
    if (pending.current) return;
    pending.current = true;
    setSpeaker(shown);
    setFailed(false);
    setBusy(true);
    // A read already on its way says what was before the change.
    reads.current += 1;
    try {
      await client.call<ChangeRingAction>("esphome.changeRing", {
        device: device.id,
        ...next.ring,
      });
    } catch {
      setSpeaker(speaker);
      setFailed(true);
    } finally {
      await read();
      pending.current = false;
      setBusy(false);
    }
  }

  if (!speaker) return null;
  const reachable = device.availability !== "offline";
  const { ring } = speaker;
  const changeRing = (next: Partial<Ring>) =>
    ring && change({ ring: next }, { ...speaker, ring: { ...ring, ...next } });

  return (
    <>
      {ring && (
        <div className="flex flex-col gap-2">
          <PageSection id="speaker-ring" title="Ring">
            <SwitchRow
              id="speaker-glow"
              label="Glow while waiting"
              detail="Otherwise it lights only while it's busy"
              checked={ring.glow}
              disabled={!reachable || busy}
              onChange={(glow) => changeRing({ glow })}
            />
            <ColourChoice
              value={ringColourOf(ring.colour)}
              disabled={!reachable}
              busy={busy}
              onChange={(colour) => changeRing({ colour })}
            />
            <BrightnessRow
              value={Math.max(20, ring.brightness)}
              disabled={!reachable || busy}
              onChange={(brightness) => changeRing({ brightness })}
            />
          </PageSection>
          <p className="m-0 px-1 text-[13px] leading-[18px] text-muted-foreground">
            Its colour and brightness are also those it shows while it listens
            and answers.
          </p>
        </div>
      )}
      {failed && (
        <Problem title="Its ring didn't change">
          ESPHome couldn't change it. Try again in a moment.
        </Problem>
      )}
    </>
  );
}
