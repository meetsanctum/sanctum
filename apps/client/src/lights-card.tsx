import { icons, type Tile } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import type { Devices } from "./use-devices";

// The card for all the lights of the home, one component wherever it is:
// Home's Lights status tile, which opens Lights' page, and the top of
// Lights' page. It is a segmented tile, frosted glass a cell high: on the
// left the bulb in Sun, "Lights" over how many are on; on the right, a cell
// square, its switch, White while any light is on as a room's button is,
// so the switch has a tile's touch target. Wider than a phone it is as
// wide as its words and switch need, at least two cells as Home's other
// status tiles are; on a phone it takes half the row as tiles do. The
// switch only turns lights off: turning every light in the home on at once
// is more than one press should do, so they come on room by room. While
// none is on it stays, dimmed and disabled, so nothing moves when it is
// pressed and the card always shows what it can do. Its words are its
// accessible name and tooltip, with how many ("Turn off 2 lights"), and
// what it did is said to a screen reader as the core answers, since the
// card's new words alone would not be heard.

// How long a card keeps what its switch did where a screen reader finds
// it: long enough to be read out, short enough not to be met as news later.
const saidForMs = 10_000;

const lightsCounted = (count: number) =>
  count === 1 ? "1 light" : `${count} lights`;

export function LightsCard(props: {
  /** The home's lights. */
  tiles: readonly Tile[];
  devices: Devices;
  /** Opens Lights' page, where the card is Home's status tile. */
  open?: () => void;
}) {
  const { tiles, devices } = props;
  // What the switch last did, for a screen reader: said once the core
  // answers, and gone a little later or when it is pressed again, so it is
  // never read as how things are now. It goes by the clock and not by the
  // lights: while a press waits for its answer they already show as off,
  // and come back on if it fails, so a light coming on cannot tell a failed
  // press from a later change.
  const [did, setDid] = useState<string>();
  const latestPress = useRef(0);
  useEffect(() => {
    if (did === undefined) return;
    const timer = window.setTimeout(() => setDid(undefined), saidForMs);
    return () => window.clearTimeout(timer);
  }, [did]);
  const on = tiles.filter((tile) => tile.on && !tile.disabled).length;
  const isOffline = tiles.every((tile) => tile.disabled);
  const status = on > 0 ? `${on} on` : isOffline ? "Offline" : "All off";
  const label = on > 0 ? `Turn off ${lightsCounted(on)}` : "Turn off lights";
  const turnOff = () => {
    const press = ++latestPress.current;
    setDid(undefined);
    // Another light can come on while this press is still waiting.
    const say = (result: string) => {
      if (press === latestPress.current) setDid(result);
    };
    void devices.switchLights({ kind: "home" }, [...tiles], "off").then(
      ({ failed }) =>
        say(
          failed.length === 0
            ? "Lights turned off"
            : `${lightsCounted(failed.length)} did not turn off`,
        ),
      () => say("The lights could not be turned off"),
    );
  };
  // The tile's left segment: the bulb, "Lights" and how many are on.
  const segment =
    "flex min-w-0 flex-1 items-center gap-2.5 bg-(--tile) px-3.5 text-left text-(--tile-ink) backdrop-blur-[24px]";
  const words = (
    <>
      <icons.Lightbulb
        aria-hidden="true"
        className="size-[18px] shrink-0 text-(--sun-text)"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] leading-[18px] font-medium text-(--tile-secondary)">
          Lights
        </span>
        {/* A pause between its lines, which a screen reader runs together. */}
        <span className="sr-only">, </span>
        <span className="truncate text-[15px] leading-5 font-medium tabular-nums">
          {status}
        </span>
      </span>
    </>
  );
  return (
    <div
      role="group"
      aria-label="Lights"
      className="col-span-3 flex h-(--cell) min-w-0 gap-0.5 overflow-hidden rounded-lg sm:w-fit sm:min-w-[calc(var(--cell)*2+var(--cell-gap))]"
    >
      {props.open ? (
        // On Home it opens Lights' page, as the other status tiles do.
        <button
          type="button"
          onClick={props.open}
          className={`${segment} outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset`}
        >
          {words}
        </button>
      ) : (
        <span className={segment}>{words}</span>
      )}
      {/* The switch, the tile's right segment: a cell square, White while
          any light is on, as a room's switch is. */}
      <button
        type="button"
        aria-label={label}
        title={label}
        data-on={on > 0 ? "" : undefined}
        disabled={on === 0}
        onClick={turnOff}
        className="grid w-(--cell) shrink-0 place-items-center bg-(--tile) text-(--tile-ink) backdrop-blur-[24px] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:opacity-50 data-on:bg-(--tile-on) data-on:text-(--tile-on-ink)"
      >
        <icons.Power aria-hidden="true" className="size-[22px]" />
      </button>
      <span role="status" className="sr-only">
        {did}
      </span>
    </div>
  );
}
