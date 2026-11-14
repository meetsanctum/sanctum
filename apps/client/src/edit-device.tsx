import type { DeviceInfo, HistoryKept } from "@meetsanctum/app-sdk";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import type { EditAction } from "./device-menu";
import { deviceProblem, updateDevice } from "./device-parts";

// Renaming a device, no longer keeping its history and removing it, from
// Settings → Devices and Needs attention.

export type Editing = {
  action: EditAction;
  device: DeviceInfo;
};

/** Keeps a device's history, or stops keeping it, which deletes it. */
export function keepHistory(device: string, kept: boolean) {
  return coreJson<HistoryKept>("/api/history/keep", {
    method: "POST",
    json: { device, kept },
  });
}

// Renaming a device, no longer keeping its history or removing it, after
// saying what that does. When its driver cannot take it off its network, as
// when the device does not answer, the dialog offers to remove it anyway.
// One its network no longer has is only forgotten.
export function EditDevice(props: {
  editing?: Editing;
  appName: string | null;
  onClose: () => void;
  onChanged: (device: DeviceInfo) => void;
  onRemoved: (id: string) => void;
  onForgotten: (id: string) => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<Editing>(undefined);
  const current = useRef(props.editing);
  current.current = props.editing;
  useEffect(
    () => () => {
      current.current = undefined;
    },
    [],
  );
  if (props.editing) last.current = props.editing;
  const editing = last.current;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  // Why removing it needs force, once a removal could not take it off.
  const [stuck, setStuck] = useState<"unanswered" | "unavailable">();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setName(props.editing?.device.name ?? "");
    setProblem(undefined);
    setStuck(undefined);
    setWorking(false);
  }, [props.editing]);

  const device = editing?.device;
  const network = props.appName
    ? `the ${props.appName} network`
    : "its network";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !device) return;
    setWorking(true);
    setProblem(undefined);
    try {
      if (editing.action === "rename") {
        props.onChanged(
          await updateDevice(device.id, { name: name.trim() || null }),
        );
      } else if (editing.action === "forget") {
        await keepHistory(device.id, false);
        props.onForgotten(device.id);
      } else {
        await coreJson("/api/devices/remove", {
          method: "POST",
          json: { id: device.id, force: stuck !== undefined },
        });
        props.onRemoved(device.id);
      }
      if (current.current === editing) props.onClose();
    } catch (error) {
      if (current.current !== editing) return;
      setWorking(false);
      if (
        editing.action === "remove" &&
        !stuck &&
        error instanceof CoreError &&
        error.status >= 500
      ) {
        setStuck(error.code === "unavailable" ? "unavailable" : "unanswered");
        return;
      }
      setProblem(deviceProblem(error));
    }
  };

  const title =
    editing?.action === "rename"
      ? "Rename this device"
      : editing?.action === "forget"
        ? `Stop keeping ${device?.name}'s history?`
        : stuck === "unanswered"
          ? `${device?.name} did not answer`
          : stuck === "unavailable"
            ? `${device?.name} cannot leave ${network}`
            : `Remove ${device?.name}?`;
  const description =
    editing?.action === "rename"
      ? "Left empty, it is named after its room."
      : editing?.action === "forget"
        ? `${productName} deletes what it has kept of it, and keeps nothing more until you turn this on again.`
        : stuck
          ? `${
              stuck === "unanswered"
                ? "It may be switched off or out of range."
                : `${props.appName ?? "Its app"} is not running.`
            } Remove it anyway? ${productName} forgets it, but the device may still try to join until it is reset.`
          : device?.leftAt
            ? `It isn't paired with ${network} any more, as after a reset, so nothing reaches it. ${productName} forgets it, with its room and name. To keep it instead, reset it and add it again.`
            : `It leaves ${network} and ${productName} forgets it, with its room and name. To use it again, reset it and add it again.`;

  return (
    <Dialog
      open={!!props.editing}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {editing?.action === "rename" && (
            <Input
              aria-label="Name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          )}
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={editing?.action === "rename" ? "default" : "destructive"}
              disabled={working}
            >
              {editing?.action === "rename"
                ? "Save"
                : editing?.action === "forget"
                  ? working
                    ? "Deleting…"
                    : "Delete history"
                  : working
                    ? "Removing…"
                    : stuck
                      ? "Remove anyway"
                      : "Remove"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
