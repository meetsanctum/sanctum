import type {
  DeviceInfo,
  EntityInfo,
  Places,
  Weekday,
} from "@meetsanctum/app-sdk";
import { Button, formatLightLevel, Input } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

import {
  capitalize,
  fieldKind,
  formatDays,
  formatLux,
  formatMinutes,
  weekOrder,
  weekdaysOnly,
  weekendsOnly,
  type FieldSchema,
} from "./words";

// The control for one field of a piece's config, chosen by the marker its
// JSON Schema carries: it opens from the field's token in a sentence, and
// shows in All options beside the field's title. A value is applied as it
// changes.

/** What the pickers list: this home's places, devices and entities. */
export type Home = {
  places: Places | undefined;
  devices: readonly DeviceInfo[];
  entities: readonly EntityInfo[];
};

export type FieldContext = {
  home: Home;
  // The config the field belongs to, for a part of the device beside it.
  config: Record<string, unknown>;
  // Which devices fit a device field, by their capabilities' kinds.
  deviceKinds?: readonly string[];
};

/** A list of options; the one in force has a check. */
export function OptionList(props: {
  label: string;
  options: { value: string; label: ReactNode; group?: string }[];
  selected: string | undefined;
  onSelect(value: string): void;
}) {
  let group: string | undefined;
  return (
    <div
      role="listbox"
      aria-label={props.label}
      className="flex max-h-80 flex-col gap-0.5 overflow-y-auto"
    >
      {props.options.map((option) => {
        const heading = option.group !== group ? option.group : undefined;
        group = option.group;
        return (
          <div
            key={`${option.group ?? ""}:${option.value}`}
            className="flex flex-col"
          >
            {heading && (
              <span className="px-2.5 pt-1.5 pb-0.5 text-[13px] leading-[18px] font-medium text-muted-foreground">
                {heading}
              </span>
            )}
            <Button
              variant="row"
              size="row"
              type="button"
              role="option"
              aria-selected={props.selected === option.value}
              onClick={() => props.onSelect(option.value)}
            >
              <span className="min-w-0 flex-1 truncate text-[15px]">
                {option.label}
              </span>
              {props.selected === option.value && (
                <Check aria-hidden="true" className="size-4 shrink-0" />
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// What is chosen takes the ink, like every active control.
const onLook =
  "data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:hover:bg-foreground/90 data-[state=on]:hover:text-background";

/** Two to four choices side by side: shadcn's toggle group, one at a time. */
export function Segments(props: {
  label: string;
  options: { value: string; label: string }[];
  selected: string | undefined;
  onSelect(value: string): void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={props.label}
      value={props.selected ?? ""}
      // Pressing the chosen one again keeps it chosen.
      onValueChange={(value: string) => value && props.onSelect(value)}
      spacing={1}
      className="w-full rounded-md bg-foreground/8 p-0.75"
    >
      {props.options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={cn(
            "h-7.5 flex-1 rounded-sm px-2.5 text-[13px] hover:bg-foreground/5",
            onLook,
          )}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function DaysControl(props: {
  value: Weekday[] | undefined;
  onChange(value: Weekday[] | undefined): void;
}) {
  const days = props.value ?? [...weekOrder];
  const same = (than: readonly Weekday[]) =>
    days.length === than.length && than.every((day) => days.includes(day));
  const preset = same(weekOrder)
    ? "every"
    : same(weekdaysOnly)
      ? "weekdays"
      : same(weekendsOnly)
        ? "weekends"
        : undefined;
  return (
    <div className="flex flex-col gap-3">
      <Segments
        label="Days"
        options={[
          { value: "every", label: "Every day" },
          { value: "weekdays", label: "Weekdays" },
          { value: "weekends", label: "Weekends" },
        ]}
        selected={preset}
        onSelect={(value) =>
          props.onChange(
            value === "every"
              ? undefined
              : [...(value === "weekdays" ? weekdaysOnly : weekendsOnly)],
          )
        }
      />
      <ToggleGroup
        type="multiple"
        aria-label="Days"
        variant="outline"
        spacing={1.5}
        value={days}
        onValueChange={(value: string[]) => {
          // A day can't be left with none.
          const next = weekOrder.filter((day) => value.includes(day));
          if (next.length === 0) return;
          props.onChange(next.length === 7 ? undefined : next);
        }}
        className="flex-wrap"
      >
        {weekOrder.map((day) => (
          <ToggleGroupItem
            key={day}
            value={day}
            size="sm"
            className={cn(
              "w-10 rounded-sm border-border text-[13px] shadow-none data-[state=on]:border-foreground",
              onLook,
            )}
          >
            {formatDays([day], "card").slice(0, 3)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function OffsetControl(props: {
  value: number;
  onChange(value: number): void;
}) {
  const side = props.value < 0 ? "before" : props.value > 0 ? "after" : "dot";
  const [minutes, setMinutes] = useState(Math.abs(props.value) || 15);
  return (
    <div className="flex flex-col gap-3">
      <Segments
        label="When"
        options={[
          { value: "before", label: "Before" },
          { value: "dot", label: "On the dot" },
          { value: "after", label: "After" },
        ]}
        selected={side}
        onSelect={(value) =>
          props.onChange(
            value === "dot" ? 0 : value === "before" ? -minutes : minutes,
          )
        }
      />
      {side !== "dot" && (
        <label className="flex items-center gap-2 text-[15px]">
          <Input
            type="number"
            min={1}
            max={720}
            value={minutes}
            onChange={(event) => {
              const next = Math.min(
                720,
                Math.max(1, Number(event.target.value) || 1),
              );
              setMinutes(next);
              props.onChange(side === "before" ? -next : next);
            }}
            className="w-24"
          />
          minutes {side}
        </label>
      )}
    </div>
  );
}

// What a node's place is, from its config: a room, a zone or the whole home.
function placeIn(config: Record<string, unknown>) {
  return Object.values(config).find(
    (value): value is { kind: "room" | "zone" | "home"; id?: string } =>
      typeof value === "object" &&
      value !== null &&
      ["room", "zone", "home"].includes(
        (value as { kind?: unknown }).kind as string,
      ),
  );
}

/**
 * A place's light level now, as the core's light-level condition reads it:
 * the highest any of its light sensors that answer reads, in lux, or null
 * when none does.
 */
export function lightLevelIn(
  home: Home,
  place: { kind: string; id?: string },
): number | null {
  const rooms =
    place.kind === "home"
      ? null
      : place.kind === "room"
        ? new Set([place.id])
        : new Set(
            home.places?.zones.find((zone) => zone.id === place.id)?.roomIds,
          );
  const levels = home.devices
    .filter(
      (device) =>
        device.availability !== "offline" &&
        (!rooms || (device.roomId !== null && rooms.has(device.roomId))),
    )
    .flatMap((device) =>
      device.capabilities.flatMap((capability) =>
        capability.kind === "sensor" &&
        capability.features.measures === "illuminance" &&
        capability.observed
          ? [capability.observed.value]
          : [],
      ),
    );
  return levels.length > 0 ? Math.max(...levels) : null;
}

// What a place is called at the start of a sentence: "Office", "The whole home".
function placeName(home: Home, place: { kind: string; id?: string }) {
  if (place.kind === "home") return "The whole home";
  const list = place.kind === "room" ? home.places?.rooms : home.places?.zones;
  return list?.find((each) => each.id === place.id)?.name;
}

// A number typed or picked from its usual values, such as minutes or a
// light level, with its unit beside it. It is applied once it is a number
// within the field's range.
function NumberChoice(props: {
  label: string;
  unit: string;
  value: number | undefined;
  minimum: number;
  maximum: number;
  whole: boolean;
  chips: { value: number; label: string }[];
  onChange(value: number): void;
  children?: ReactNode;
}) {
  const [text, setText] = useState(
    props.value === undefined ? "" : String(props.value),
  );
  useEffect(() => {
    setText((current) =>
      props.value === undefined || Number(current) === props.value
        ? current
        : String(props.value),
    );
  }, [props.value]);
  const number = Number(text);
  const valid =
    text.trim() !== "" &&
    Number.isFinite(number) &&
    number >= props.minimum &&
    number <= props.maximum &&
    (!props.whole || Number.isInteger(number));
  return (
    <div className="flex flex-col gap-3">
      <label className="relative flex items-center">
        <Input
          type="number"
          inputMode={props.whole ? "numeric" : "decimal"}
          aria-label={props.label}
          aria-invalid={text.trim() !== "" && !valid}
          min={props.minimum}
          max={props.maximum}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const next = Number(event.target.value);
            if (
              event.target.value.trim() !== "" &&
              Number.isFinite(next) &&
              next >= props.minimum &&
              next <= props.maximum &&
              (!props.whole || Number.isInteger(next))
            ) {
              props.onChange(next);
            }
          }}
          className={cn(
            "tabular-nums",
            props.unit.length > 2 ? "pe-20" : "pe-9",
          )}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute end-3 text-[15px] text-muted-foreground"
        >
          {props.unit}
        </span>
      </label>
      <ToggleGroup
        type="single"
        aria-label={`Usual ${props.label.toLowerCase()}`}
        variant="outline"
        spacing={1.5}
        value={props.value === undefined ? "" : String(props.value)}
        onValueChange={(value: string) => {
          if (!value) return;
          setText(value);
          props.onChange(Number(value));
        }}
        className="flex-wrap"
      >
        {props.chips.map((chip) => (
          <ToggleGroupItem
            key={chip.value}
            value={String(chip.value)}
            size="sm"
            className={cn(
              "rounded-sm border-border px-2.5 text-[13px] shadow-none data-[state=on]:border-foreground",
              onLook,
            )}
          >
            {chip.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {props.children}
    </div>
  );
}

const minuteChips = [2, 5, 10, 15, 30, 60];
const luxChips = [5, 10, 30, 50, 100];

/** The control for a field, by what its schema says it is. */
export function FieldControl(props: {
  name: string;
  field: FieldSchema;
  value: unknown;
  context: FieldContext;
  onChange(value: unknown): void;
}) {
  const kind = fieldKind(props.field);
  const { home } = props.context;
  const rooms = home.places?.rooms ?? [];
  const zones = home.places?.zones ?? [];
  const label = String(props.field.title ?? capitalize(props.name));
  switch (kind.kind) {
    case "timeOfDay":
      return (
        <Input
          type="time"
          aria-label={label}
          value={typeof props.value === "string" ? props.value : ""}
          onChange={(event) =>
            event.target.value && props.onChange(event.target.value)
          }
        />
      );
    case "days":
      return (
        <DaysControl
          value={props.value as Weekday[] | undefined}
          onChange={props.onChange}
        />
      );
    case "offsetMinutes":
      return (
        <OffsetControl
          value={typeof props.value === "number" ? props.value : 0}
          onChange={props.onChange}
        />
      );
    case "minutes":
      return (
        <NumberChoice
          label={String(props.field.title ?? "Minutes")}
          unit="minutes"
          value={typeof props.value === "number" ? props.value : undefined}
          minimum={numberOr(props.field.minimum, 1)}
          maximum={numberOr(props.field.maximum, 240)}
          whole
          chips={minuteChips.map((value) => ({
            value,
            label: formatMinutes(value, "card"),
          }))}
          onChange={props.onChange}
        />
      );
    case "lux": {
      // What the node's place reads now, beside the level to compare it with.
      const place = placeIn(props.context.config);
      const level = place ? lightLevelIn(home, place) : null;
      const name = place && placeName(home, place);
      return (
        <NumberChoice
          label={String(props.field.title ?? "Light level")}
          unit="lx"
          value={typeof props.value === "number" ? props.value : undefined}
          minimum={numberOr(props.field.minimum, 0)}
          maximum={numberOr(props.field.maximum, 200_000)}
          whole={false}
          chips={luxChips.map((value) => ({ value, label: formatLux(value) }))}
          onChange={props.onChange}
        >
          {level !== null && name && (
            <p className="m-0 flex items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
              <Sun aria-hidden="true" className="size-3.5 shrink-0" />
              {name} reads {formatLightLevel(level)} now
            </p>
          )}
        </NumberChoice>
      );
    }
    case "choice": {
      const options = Object.entries(kind.labels).map(([value, text]) => ({
        value,
        label: capitalize(text),
      }));
      return options.length <= 3 ? (
        <Segments
          label={label}
          options={options}
          selected={props.value as string | undefined}
          onSelect={props.onChange}
        />
      ) : (
        <OptionList
          label={label}
          options={options}
          selected={props.value as string | undefined}
          onSelect={props.onChange}
        />
      );
    }
    case "boolean":
      return (
        <Segments
          label={label}
          options={[
            { value: "true", label: "On" },
            { value: "false", label: "Off" },
          ]}
          selected={
            props.value === undefined ? undefined : String(props.value === true)
          }
          onSelect={(value) => props.onChange(value === "true")}
        />
      );
    case "names": {
      if (kind.names === "device") {
        const kinds = props.context.deviceKinds;
        const devices = home.devices.filter(
          (device) =>
            !kinds ||
            device.capabilities.some((capability) =>
              kinds.includes(capability.kind),
            ),
        );
        const roomName = (id: string | null) =>
          rooms.find((room) => room.id === id)?.name ?? "No room";
        return (
          <OptionList
            label={label}
            options={[...devices]
              .sort(
                (a, b) =>
                  roomName(a.roomId).localeCompare(roomName(b.roomId)) ||
                  a.name.localeCompare(b.name),
              )
              .map((device) => ({
                value: device.id,
                label: device.name,
                group: roomName(device.roomId),
              }))}
            selected={props.value as string | undefined}
            onSelect={props.onChange}
          />
        );
      }
      const list = kind.names === "room" ? rooms : zones;
      return (
        <OptionList
          label={label}
          options={list.map((each) => ({ value: each.id, label: each.name }))}
          selected={props.value as string | undefined}
          onSelect={props.onChange}
        />
      );
    }
    case "place": {
      const value = props.value as { kind?: string; id?: string } | undefined;
      const selected = value?.kind === "home" ? "home" : value?.id;
      return (
        <OptionList
          label={label}
          options={[
            ...rooms.map((room) => ({
              value: `room:${room.id}`,
              label: room.name,
              group: "Rooms",
            })),
            ...zones.map((zone) => ({
              value: `zone:${zone.id}`,
              label: zone.name,
              group: "Zones",
            })),
            { value: "home", label: "The whole home", group: "Everywhere" },
          ]}
          selected={
            selected === "home"
              ? "home"
              : value
                ? `${value.kind}:${selected}`
                : undefined
          }
          onSelect={(picked) => {
            if (picked === "home") return props.onChange({ kind: "home" });
            const [placeKind, id] = picked.split(":");
            props.onChange({ kind: placeKind, id });
          }}
        />
      );
    }
    case "entityOf":
      return (
        <OptionList
          label={label}
          options={home.entities
            .filter((entity) => entity.type === kind.type)
            .map((entity) => ({ value: entity.key, label: entity.name }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          selected={props.value as string | undefined}
          onSelect={props.onChange}
        />
      );
    case "partOf": {
      const of = props.context.config[kind.of];
      const device = home.devices.find((each) => each.id === of);
      return (
        <OptionList
          label={label}
          options={(device?.capabilities ?? []).map((capability) => ({
            value: capability.id,
            label: `${capitalize(capability.kind)} (${capability.id})`,
          }))}
          selected={props.value as string | undefined}
          onSelect={props.onChange}
        />
      );
    }
    case "options":
      return (
        <OptionList
          label={label}
          options={kind.options.map((value) => ({ value, label: value }))}
          selected={props.value as string | undefined}
          onSelect={props.onChange}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          aria-label={label}
          min={kind.minimum}
          max={kind.maximum}
          value={typeof props.value === "number" ? props.value : ""}
          onChange={(event) =>
            props.onChange(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            )
          }
        />
      );
    case "text":
      return (
        <Input
          aria-label={label}
          value={typeof props.value === "string" ? props.value : ""}
          onChange={(event) =>
            props.onChange(
              event.target.value === "" ? undefined : event.target.value,
            )
          }
        />
      );
    default:
      return (
        <JsonControl
          label={label}
          value={props.value}
          onChange={props.onChange}
        />
      );
  }
}

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" ? value : fallback;

// Anything else, such as a command's record: JSON, checked as it is typed.
function JsonControl(props: {
  label: string;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const [text, setText] = useState(() =>
    props.value === undefined ? "" : JSON.stringify(props.value, null, 2),
  );
  const [valid, setValid] = useState(true);
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label={props.label}
        aria-invalid={!valid}
        value={text}
        rows={4}
        onChange={(event) => {
          setText(event.target.value);
          if (event.target.value.trim() === "") {
            setValid(true);
            props.onChange(undefined);
            return;
          }
          try {
            props.onChange(JSON.parse(event.target.value));
            setValid(true);
          } catch {
            setValid(false);
          }
        }}
        className={cn(
          "w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      />
      {!valid && (
        <span className="text-[13px] leading-[18px] font-medium">
          Use JSON, such as {'{ "on": true }'}
        </span>
      )}
    </div>
  );
}
