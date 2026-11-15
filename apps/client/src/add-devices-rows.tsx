import type {
  DeviceInfo,
  DeviceType,
  JoinedDevice,
  Room,
} from "@meetsanctum/app-sdk";
import { Input } from "@meetsanctum/ui-sdk";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { productName } from "./brand";
import { DeviceIcon, RoomPicker, showAsOf, ShowAsPicker } from "./device-parts";

// The rows of Add devices for a device that joined or was added there: how
// far it has come while it joins, and once it is ready its name, what it is
// shown as and its room, set right in the row.

/** What a row saves of its device. */
export type DeviceChanges = {
  name?: string | null;
  roomId?: string | null;
  shownAs?: DeviceType | null;
};

/**
 * How far a device that joined has come, as the dialog says it. One that is
 * ready and has nothing Sanctum can use says so: it is the household's to
 * name and place all the same.
 */
export function stageText(joined: JoinedDevice, device?: DeviceInfo) {
  switch (joined.stage) {
    case "joined":
      return "Joining…";
    case "interviewing":
      return "Setting up…";
    case "ready":
      if (device && device.capabilities.length === 0) {
        return `${productName} cannot use it`;
      }
      return joined.known ? "Joined again" : "Ready";
    case "unsupported":
      return `${productName} cannot use it`;
    case "failed":
      return "It did not finish joining. Reset it and try again.";
  }
}

// A device added or ready, named and placed right here.
export function ReadyRow(props: {
  device: DeviceInfo;
  detail: string;
  rooms: readonly Room[];
  onSave: (device: DeviceInfo, changes: DeviceChanges) => Promise<void>;
}) {
  const { device } = props;
  // A device that may be shown as another type has that and its room under
  // its name, whichever is chosen, so its name keeps room to be read.
  const stacked = showAsOf(device) !== null;
  return (
    <li className="flex items-start gap-3">
      <DeviceIcon device={device} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          className={
            stacked ? "flex flex-col gap-2" : "flex items-center gap-2"
          }
        >
          <div className={stacked ? "flex" : "flex min-w-0 flex-1"}>
            <NameField
              device={device}
              onSave={(name) => void props.onSave(device, { name })}
            />
          </div>
          <div
            className={
              // On a phone a long room goes under what it is shown as.
              stacked
                ? "flex flex-wrap items-center gap-2"
                : "flex shrink-0 items-center gap-2"
            }
          >
            <ShowAsPicker
              device={device}
              onChange={(shownAs) => void props.onSave(device, { shownAs })}
            />
            <RoomPicker
              device={device}
              rooms={props.rooms}
              onChange={(roomId) => void props.onSave(device, { roomId })}
            />
          </div>
        </div>
        <span className="text-[13px] font-medium text-muted-foreground">
          {props.detail}
        </span>
      </div>
    </li>
  );
}

export function JoinedRow(props: {
  joined: JoinedDevice;
  device?: DeviceInfo;
  rooms: readonly Room[];
  onSave: (device: DeviceInfo, changes: DeviceChanges) => Promise<void>;
}) {
  const { joined, device } = props;
  const working = joined.stage === "joined" || joined.stage === "interviewing";
  const detail = [
    device && joined.description !== device.name ? joined.description : null,
    stageText(joined, device),
  ]
    .filter(Boolean)
    .join(" · ");
  if (joined.stage === "ready" && device) {
    return (
      <ReadyRow
        device={device}
        detail={detail}
        rooms={props.rooms}
        onSave={props.onSave}
      />
    );
  }
  return (
    <li className="flex items-start gap-3">
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
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* A device the home has goes by its name while it joins again. */}
        <span className="truncate text-sm font-medium">
          {device?.name ?? joined.description ?? "New device"}
        </span>
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
