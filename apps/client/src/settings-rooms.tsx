import type {
  DeviceInfo,
  Floor,
  Places,
  Room,
  RoomRemoval,
} from "@meetsanctum/app-sdk";
import { Button, Input, type LiveFeed } from "@meetsanctum/ui-sdk";
import { DoorOpen, EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { productName } from "./brand";
import { Row, Section } from "./components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { coreDevices } from "./core-devices";
import { CoreError, coreJson } from "./core-fetch";

// Settings → Rooms: the home's rooms, which the core keeps, with their floor
// and how many devices are in each, for every client, a shared one too, to
// add, rename and remove them. Removing one first says what goes with it,
// which the core works out.

export function roomDetail(
  room: Room,
  floors: readonly Floor[],
  devices: readonly DeviceInfo[],
): string {
  const count = devices.filter((device) => device.roomId === room.id).length;
  return [
    floors.find((floor) => floor.id === room.floorId)?.name ?? null,
    count === 0 ? "No devices" : count === 1 ? "1 device" : `${count} devices`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// A count of things of an entity type, from its title, such as "4 moods"
// from Mood. A title that starts with an acronym, such as CO2 sensor, keeps
// its capitals.
export function counted(count: number, title: string): string {
  const noun = /^[A-Z][^A-Z]/.test(title)
    ? title[0]!.toLowerCase() + title.slice(1)
    : title;
  if (count === 1) return `1 ${noun}`;
  const plural = /[^aeiou]y$/.test(noun)
    ? `${noun.slice(0, -1)}ies`
    : /(s|x|z|ch|sh)$/.test(noun)
      ? `${noun}es`
      : `${noun}s`;
  return `${count} ${plural}`;
}

const and = (items: readonly string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/** What removing a room takes with it, a sentence each; none when nothing does. */
export function removalWarning(removal: RoomRemoval): string[] {
  const lines: string[] = [];
  const [device, ...others] = removal.devices;
  if (device) {
    lines.push(
      others.length === 0
        ? `${device.name} moves to No room and stays paired.`
        : `Its ${removal.devices.length} devices move to No room and stay paired.`,
    );
  }
  if (removal.entities.length > 0) {
    const total = removal.entities.reduce((sum, each) => sum + each.count, 0);
    lines.push(
      `${and(removal.entities.map((each) => counted(each.count, each.title)))} ${total === 1 ? "goes" : "go"} with it.`,
    );
  }
  if (removal.workflows.length > 0) {
    const names = and(removal.workflows.map((each) => `“${each.name}”`));
    lines.push(
      removal.workflows.length === 1
        ? `The workflow ${names} uses it and will need changing.`
        : `The workflows ${names} use it and will need changing.`,
    );
  }
  return lines;
}

function roomProblem(error: unknown) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "not_found":
        return "That room is not there any more.";
    }
    return `${productName} ran into a problem. Try again.`;
  }
  return `Can't reach ${productName}. Try again.`;
}

type Editing = { action: "add" } | { action: "rename" | "remove"; room: Room };

type Change<T> = (current: T) => T;

export function RoomsSection(props: {
  live: LiveFeed;
  // Opens with Add room, as the dashboard's setup does.
  adding?: boolean;
}) {
  const [places, setPlaces] = useState<Places>();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [editing, setEditing] = useState<Editing | undefined>(() =>
    props.adding ? { action: "add" } : undefined,
  );

  // What changed while a refresh was on its way is newer than its answer,
  // so it is applied on top of it, as Devices does.
  const pending = useRef<{
    places: Change<Places>[];
    devices: Change<DeviceInfo[]>[];
  }>(undefined);
  const changePlaces = useCallback((change: Change<Places>) => {
    pending.current?.places.push(change);
    setPlaces((current) => current && change(current));
  }, []);
  const changeDevices = useCallback((change: Change<DeviceInfo[]>) => {
    pending.current?.devices.push(change);
    setDevices(change);
  }, []);

  const refresh = useCallback(async () => {
    const request = {
      places: [] as Change<Places>[],
      devices: [] as Change<DeviceInfo[]>[],
    };
    pending.current = request;
    try {
      const [nextPlaces, nextDevices] = await Promise.all([
        coreJson<Places>("/api/places"),
        coreDevices(),
      ]);
      if (pending.current !== request) return;
      setPlaces(
        request.places.reduce((current, change) => change(current), nextPlaces),
      );
      setDevices(
        request.devices.reduce(
          (current, change) => change(current),
          nextDevices,
        ),
      );
    } finally {
      if (pending.current === request) pending.current = undefined;
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return props.live.subscribe({
      message(message) {
        if (message.type === "places") {
          pending.current?.places.push(() => message.places);
          setPlaces(message.places);
        } else if (message.type === "device") {
          changeDevices((current) => {
            const others = current.filter((each) => each.id !== message.id);
            return message.device ? [...others, message.device] : others;
          });
        }
      },
      refresh: () => void refresh().catch(() => undefined),
    });
  }, [refresh, changeDevices, props.live]);

  // Read again rather than apply a saved room: another client may have
  // changed it since, and its live message may have come first, as
  // dashboards.ts does. A removed room cannot come back, so it goes at once,
  // and its devices with it to No room.
  const saved = () => void refresh().catch(() => undefined);
  const removed = (id: string) => {
    changePlaces((current) => ({
      ...current,
      rooms: current.rooms.filter((each) => each.id !== id),
    }));
    changeDevices((current) =>
      current.map((device) =>
        device.roomId === id ? { ...device, roomId: null } : device,
      ),
    );
  };

  return (
    <Section
      id="settings-rooms"
      title="Rooms"
      action={
        <Button size="sm" onClick={() => setEditing({ action: "add" })}>
          Add room
        </Button>
      }
    >
      {places &&
        (places.rooms.length === 0 ? (
          <p className="m-0 text-[13px] font-medium text-muted-foreground">
            No rooms yet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {places.rooms.map((room) => (
              <li key={room.id} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
                >
                  <DoorOpen className="size-4" />
                </span>
                <Row
                  title={room.name}
                  detail={roomDetail(room, places.floors, devices)}
                />
                <RoomMenu
                  room={room}
                  onEdit={(action) => setEditing({ action, room })}
                />
              </li>
            ))}
          </ul>
        ))}
      <EditRoom
        editing={editing}
        onClose={() => setEditing(undefined)}
        onSaved={saved}
        onRemoved={removed}
      />
    </Section>
  );
}

function RoomMenu(props: {
  room: Room;
  onEdit: (action: "rename" | "remove") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${props.room.name}: more`}
          className="ms-auto"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => props.onEdit("rename")}>
          <Pencil />
          Rename
        </DropdownMenuItem>
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

// Adding or renaming a room, or removing it once the core has said what
// goes with it.
function EditRoom(props: {
  editing?: Editing;
  onClose: () => void;
  onSaved: () => void;
  onRemoved: (id: string) => void;
}) {
  // What the dialog showed stays while it closes. `current` is what it
  // shows once committed, so an answer for an earlier room is dropped;
  // render writes no refs.
  const [editing, setEditing] = useState(props.editing);
  if (props.editing && props.editing !== editing) setEditing(props.editing);
  const current = useRef<Editing>(undefined);
  useEffect(() => {
    current.current = props.editing;
    return () => {
      current.current = undefined;
    };
  }, [props.editing]);
  const [name, setName] = useState("");
  const [removal, setRemoval] = useState<RoomRemoval>();
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const opened = props.editing;
    setName(opened?.action === "rename" ? opened.room.name : "");
    setRemoval(undefined);
    setProblem(undefined);
    setWorking(false);
    if (opened?.action !== "remove") return;
    coreJson<RoomRemoval>(
      `/api/places/rooms/removal?id=${encodeURIComponent(opened.room.id)}`,
    ).then(
      (answer) => {
        if (current.current === opened) setRemoval(answer);
      },
      (error: unknown) => {
        if (current.current === opened) setProblem(roomProblem(error));
      },
    );
  }, [props.editing]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setWorking(true);
    setProblem(undefined);
    try {
      if (editing.action === "add") {
        await coreJson("/api/places/rooms/add", {
          method: "POST",
          json: { name: name.trim() },
        });
        props.onSaved();
      } else if (editing.action === "rename") {
        await coreJson("/api/places/rooms/update", {
          method: "POST",
          json: { id: editing.room.id, name: name.trim() },
        });
        props.onSaved();
      } else {
        await coreJson("/api/places/rooms/remove", {
          method: "POST",
          json: { id: editing.room.id },
        });
        props.onRemoved(editing.room.id);
      }
      if (current.current === editing) props.onClose();
    } catch (error) {
      if (current.current !== editing) return;
      setWorking(false);
      setProblem(roomProblem(error));
    }
  };

  const warning = removal && removalWarning(removal);
  const title =
    editing?.action === "add"
      ? "Add a room"
      : editing?.action === "rename"
        ? "Rename this room"
        : `Remove ${editing?.room.name}?`;
  const description =
    editing?.action === "add"
      ? "Then put devices in it from their menu in Devices."
      : editing?.action === "rename"
        ? "Devices named after it follow the new name."
        : !removal
          ? problem
            ? `${productName} could not say what goes with it.`
            : "Looking at what goes with it…"
          : "Apps remove any content they keep for this room.";

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
          {editing?.action === "remove"
            ? warning &&
              warning.length > 0 && (
                <ul className="m-0 flex list-disc flex-col gap-1.5 ps-5 text-sm">
                  {warning.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )
            : editing && (
                <Input
                  aria-label="Name"
                  value={name}
                  maxLength={60}
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
              variant={editing?.action === "remove" ? "destructive" : "default"}
              disabled={
                working ||
                (editing?.action === "remove"
                  ? !removal
                  : name.trim().length === 0)
              }
            >
              {editing?.action === "add"
                ? "Add"
                : editing?.action === "rename"
                  ? "Save"
                  : working
                    ? "Removing…"
                    : "Remove"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
