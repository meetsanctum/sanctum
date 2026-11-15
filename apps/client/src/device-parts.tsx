import {
  deviceTypes,
  showAsChoices,
  type DeviceInfo,
  type DeviceType,
  type Room,
} from "@meetsanctum/app-sdk";
import { Button, ContactClosed, WindowClosed } from "@meetsanctum/ui-sdk";
import {
  ChevronDown,
  CircleDot,
  DoorClosed,
  Footprints,
  Lightbulb,
  Power,
  Radio,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { productName } from "./brand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { coreDevice } from "./core-devices";
import { CoreError } from "./core-fetch";

// What Settings → Devices and adding devices share: a device's icon, the
// room it is in, and saving what the household decides about it.

const typeIcons: Record<DeviceType, LucideIcon> = {
  light: Lightbulb,
  plug: Power,
  switch: Power,
  button: CircleDot,
  motion: Footprints,
  contact: ContactClosed,
  door: DoorClosed,
  window: WindowClosed,
  sensor: Thermometer,
  unknown: Radio,
};

/**
 * A light, a switch, a remote, a motion sensor, a contact sensor or the
 * door or window it is shown as, a sensor, or something else, in the round
 * a row starts with: its type's icon, and the general
 * one for a type this client has none for, as a core may serve.
 */
// By what it is: a device's type, or what its driver says a device it found
// is.
export function DeviceIcon(props: {
  device?: DeviceInfo;
  type?: string | null;
}) {
  // A found device has only its driver's word, which cannot choose a type
  // reserved for the household.
  const type =
    props.device?.type ??
    deviceTypes.find((each) => each.id === props.type && !each.chosenOnly)?.id;
  const Icon: LucideIcon =
    type && Object.hasOwn(typeIcons, type)
      ? typeIcons[type as DeviceType]
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

/**
 * Saves a device's name, its room or what it is shown as; a name left empty
 * names it after its room, and no type shows it as what it is.
 */
export function updateDevice(
  id: string,
  changes: {
    name?: string | null;
    roomId?: string | null;
    shownAs?: DeviceType | null;
  },
) {
  return coreDevice("/api/devices/update", {
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

/**
 * What the household may show a device as, by its types' titles with its
 * own first, and which is in effect; nothing for a device that can only be
 * shown as what it is.
 */
export function showAsOf(device: Pick<DeviceInfo, "type" | "shownAs">) {
  const [own, ...others] = showAsChoices(device.type, device.shownAs);
  if (!own) return null;
  const title = (id: DeviceType) =>
    deviceTypes.find((type) => type.id === id)!.title;
  return {
    current: device.type,
    options: [own, ...others].map((id) => ({ id, title: title(id) })),
    // The choice to save for an option: none for the device's own type.
    choice: (id: string) =>
      id === own ? null : (others.find((each) => each === id) ?? null),
  };
}

/** What a device is shown as, as a menu of the types its own may be shown as. */
export function ShowAsPicker(props: {
  device: DeviceInfo;
  onChange: (shownAs: DeviceType | null) => void;
  disabled?: boolean;
}) {
  const showAs = showAsOf(props.device);
  if (!showAs) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled}
          aria-label={`${props.device.name}: show as`}
          className="max-w-40 shrink-0"
        >
          <span className="truncate">
            {showAs.options.find((each) => each.id === showAs.current)?.title}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={showAs.current}
          onValueChange={(value) => props.onChange(showAs.choice(value))}
        >
          {showAs.options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.title}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
