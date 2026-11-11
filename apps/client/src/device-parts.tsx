import type { DeviceInfo, Room } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import {
  ChevronDown,
  CircleDot,
  Footprints,
  Lightbulb,
  Power,
  Radio,
  Thermometer,
} from "lucide-react";

import { productName } from "./brand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { CoreError, coreJson } from "./core-fetch";

// What Settings → Devices and adding devices share: a device's icon, the
// room it is in, and saving what the household decides about it.

/** A light, a switch, a remote, a motion sensor, a sensor, or something else, in the round a row starts with. */
export function DeviceIcon(props: { device?: DeviceInfo }) {
  const kinds = new Set(props.device?.capabilities.map((each) => each.kind));
  const Icon = kinds.has("light")
    ? Lightbulb
    : kinds.has("switch")
      ? Power
      : kinds.has("button")
        ? CircleDot
        : kinds.has("occupancy")
          ? Footprints
          : kinds.has("sensor")
            ? Thermometer
            : Radio;
  return (
    <span
      aria-hidden="true"
      // The ink at 12%, so it shows on Settings' card in both modes.
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/12"
    >
      <Icon className="size-4" />
    </span>
  );
}

export function roomName(rooms: readonly Room[], roomId: string | null) {
  return rooms.find((room) => room.id === roomId)?.name ?? null;
}

/** Saves a device's name or room; a name left empty names it after its room. */
export function updateDevice(
  id: string,
  changes: { name?: string | null; roomId?: string | null },
) {
  return coreJson<DeviceInfo>("/api/devices/update", {
    method: "POST",
    json: { id, ...changes },
  });
}

export function deviceProblem(error: unknown) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "not_found":
        return "That device is not there any more.";
    }
    return `${productName} ran into a problem. Try again.`;
  }
  return `Can't reach ${productName}. Try again.`;
}

const noRoom = "none";

/** Which room a device is in, as a menu of the home's rooms. */
export function RoomPicker(props: {
  device: DeviceInfo;
  rooms: readonly Room[];
  onChange: (roomId: string | null) => void;
  disabled?: boolean;
  // What it says while the device is in no room.
  unset?: string;
}) {
  const current = roomName(props.rooms, props.device.roomId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled}
          aria-label={`${props.device.name}: room`}
          className="max-w-40 shrink-0"
        >
          <span className="truncate">
            {current ?? props.unset ?? "No room"}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup
          value={props.device.roomId ?? noRoom}
          onValueChange={(value) =>
            props.onChange(value === noRoom ? null : value)
          }
        >
          {props.rooms.map((room) => (
            <DropdownMenuRadioItem key={room.id} value={room.id}>
              {room.name}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value={noRoom}>No room</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
