import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import {
  Activity,
  CircleStop,
  DoorOpen,
  EllipsisVertical,
  History,
  House,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { whyNot, type CheckResult } from "./device-firmware";
import { hasMotionSettings, occupancyOf } from "./motion-settings";

// A device's menu in Settings → Devices: its firmware's version, then
// renaming it, its room, whether it shows on Home, whether its history is
// kept, a motion sensor's settings, its checks, dimmed with why when they
// cannot run, Repair where its driver says how to set it right, and
// removing it.

/** What the menu asks Settings → Devices to do with a dialog. */
export type EditAction = "rename" | "forget" | "remove";

const noRoom = "none";

export function DeviceMenu(props: {
  device: DeviceInfo;
  rooms: Places["rooms"];
  result?: CheckResult;
  // Whether its history is kept; none for a device without one.
  kept?: boolean;
  onKeep: () => void;
  // Whether it is on Home, by Home's name; none until that is known.
  home?: { name: string; on: boolean };
  onHome: (on: boolean) => void;
  onEdit: (action: EditAction) => void;
  onRoom: (roomId: string | null) => void;
  onMotion: () => void;
  onCheck: () => void;
  onProbe: () => void;
  onStop: () => void;
  // Repair, for a device whose driver says how to set it right.
  onRepair?: () => void;
}) {
  const { device, result } = props;
  const isChecking = result?.kind === "checking" || result?.kind === "probing";
  const noUpdate = whyNot(device, "update");
  const noProbe = whyNot(device, "probe");
  const state = device.firmware?.state;
  const isRunning = state === "updating" || state === "waiting";
  const motion = occupancyOf(device);
  const noMotionSettings =
    motion && !hasMotionSettings(motion.features)
      ? "It has none to change"
      : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${props.device.name}: more`}
          className="ms-auto"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {device.firmware?.version && (
          <DropdownMenuLabel>
            Firmware {device.firmware.version}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem onSelect={() => props.onEdit("rename")}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <DoorOpen />
            Room
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup
              value={props.device.roomId ?? noRoom}
              onValueChange={(value) =>
                props.onRoom(value === noRoom ? null : value)
              }
            >
              {props.rooms.map((room) => (
                <DropdownMenuRadioItem key={room.id} value={room.id}>
                  {room.name}
                </DropdownMenuRadioItem>
              ))}
              <DropdownMenuRadioItem value={noRoom}>
                No room
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {props.home && (
          <DropdownMenuCheckboxItem
            checked={props.home.on}
            onCheckedChange={(checked) => props.onHome(checked)}
          >
            <House />
            Show on {props.home.name}
          </DropdownMenuCheckboxItem>
        )}
        {props.kept !== undefined && (
          <DropdownMenuCheckboxItem
            checked={props.kept}
            // Not keeping it deletes it, so that asks first.
            onCheckedChange={(checked) =>
              checked ? props.onKeep() : props.onEdit("forget")
            }
          >
            <History />
            Keep history
          </DropdownMenuCheckboxItem>
        )}
        {motion && (
          <MenuCheck
            icon={SlidersHorizontal}
            label="Motion settings"
            why={noMotionSettings}
            disabled={noMotionSettings !== null}
            onSelect={props.onMotion}
          />
        )}
        <MenuCheck
          icon={RefreshCw}
          label="Check for update"
          why={noUpdate}
          disabled={isChecking || isRunning || noUpdate !== null}
          onSelect={props.onCheck}
        />
        <MenuCheck
          icon={Activity}
          label="Check connection"
          why={noProbe}
          disabled={isChecking || noProbe !== null}
          onSelect={props.onProbe}
        />
        {isRunning && (
          <DropdownMenuItem onSelect={props.onStop}>
            <CircleStop />
            {state === "waiting" ? "Cancel update" : "Stop update"}
          </DropdownMenuItem>
        )}
        {device.problem?.repair && props.onRepair && (
          <DropdownMenuItem onSelect={props.onRepair}>
            <Wrench />
            Repair
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => props.onEdit("remove")}
        >
          <Trash2 />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A check or a motion sensor's settings in a device's menu, dimmed with why
// when it cannot run, so what exists stays where it is.
function MenuCheck(props: {
  icon: typeof RefreshCw;
  label: string;
  why: string | null;
  disabled: boolean;
  onSelect: () => void;
}) {
  const Icon = props.icon;
  return (
    <DropdownMenuItem disabled={props.disabled} onSelect={props.onSelect}>
      <Icon />
      <span className="flex flex-col">
        {props.label}
        {props.why && (
          <span className="text-xs text-muted-foreground">{props.why}</span>
        )}
      </span>
    </DropdownMenuItem>
  );
}
