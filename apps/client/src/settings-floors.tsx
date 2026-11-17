import type { Floor, FloorRemoval, Places } from "@meetsanctum/app-sdk";
import { Button, Input } from "@meetsanctum/ui-sdk";
import {
  EllipsisVertical,
  GripVertical,
  Layers,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { productName } from "./brand";
import { Row, Section } from "./components";
import { Checkbox } from "./components/ui/checkbox";
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
import { CoreError, coreJson } from "./core-fetch";

// Settings → Rooms' floors, before its rooms: each floor in the household's
// order, which every list of floors follows, with the rooms on it. A floor
// is dragged into its place by its grip, or moved with the arrow keys from
// it. Its menu edits it, in one sheet for a new floor and an existing one
// with suggested names and the home's rooms to put on it, or removes it once
// the core has said what goes with it.

/** Names the editor suggests, those the home has left out. */
export const suggestedFloorNames = [
  "Ground floor",
  "First floor",
  "Basement",
  "Outside",
] as const;

const and = (items: readonly string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/** A floor's line: the rooms on it by name. */
export function floorDetail(floor: Floor, places: Places): string {
  const rooms = places.rooms
    .filter((room) => room.floorId === floor.id)
    .map((room) => room.name);
  return rooms.length === 0 ? "No rooms yet" : and(rooms);
}

/** What removing a floor takes with it, a sentence each. */
export function floorRemovalWarning(removal: FloorRemoval): string[] {
  const lines: string[] = [];
  const rooms = removal.rooms.map((room) => room.name);
  if (rooms.length > 0) {
    lines.push(
      `${and(rooms)} ${rooms.length === 1 ? "stays" : "stay"}, on no floor.`,
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

/** The floors in a new order, numbered from 0 as the core numbers them. */
export function inOrder(places: Places, ids: readonly string[]): Places {
  const floors = ids.flatMap((id, level) => {
    const floor = places.floors.find((each) => each.id === id);
    return floor ? [{ ...floor, level }] : [];
  });
  return { ...places, floors };
}

function floorProblem(error: unknown) {
  if (error instanceof CoreError) {
    if (error.code === "not_found") return "That floor is not there any more.";
    return `${productName} ran into a problem. Try again.`;
  }
  return `Can't reach ${productName}. Try again.`;
}

export type FloorEditing =
  // A new floor, with a room on it already when its menu asked for it.
  | { action: "add"; roomId?: string }
  | { action: "edit" | "remove"; floor: Floor };

type Drag = { id: string; pointerId: number; ids: string[] };

export function FloorsSection(props: {
  places: Places;
  onEdit: (editing: FloorEditing) => void;
  onOrder: (ids: string[]) => void;
}) {
  const { places } = props;
  // The floors' order while a drag moves one, until it ends.
  const [moving, setMoving] = useState<Drag | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  // The floor the arrow keys just moved, whose grip keeps focus though its
  // row moved.
  const refocus = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const grip = grips.current.get(id);
    if (grip && document.activeElement !== grip) grip.focus();
  });

  const ids = places.floors.map((floor) => floor.id);
  const shown = moving
    ? moving.ids.flatMap(
        (id) => places.floors.find((floor) => floor.id === id) ?? [],
      )
    : places.floors;
  const nameOf = (id: string) =>
    places.floors.find((floor) => floor.id === id)?.name ?? "The floor";

  const order = (next: string[]) => {
    if (next.join() !== ids.join()) props.onOrder(next);
  };

  const keys = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const by =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
    if (by === null) return;
    event.preventDefault();
    const next = [...ids];
    const from = next.indexOf(id);
    const to = Math.max(0, Math.min(next.length - 1, from + by));
    if (from === to) return;
    next.splice(to, 0, ...next.splice(from, 1));
    refocus.current = id;
    setAnnouncement(`${nameOf(id)}, ${to + 1} of ${next.length}`);
    order(next);
  };

  const drag = (id: string) => ({
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.isPrimary === false || event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setMoving({ id, pointerId: event.pointerId, ids });
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      if (moving?.pointerId !== event.pointerId) return;
      // The row under the pointer makes room for the dragged one.
      for (const other of moving.ids) {
        if (other === id) continue;
        const box = rows.current.get(other)?.getBoundingClientRect();
        if (box && event.clientY >= box.top && event.clientY <= box.bottom) {
          const next = moving.ids.filter((each) => each !== id);
          next.splice(moving.ids.indexOf(other), 0, id);
          setMoving({ ...moving, ids: next });
          break;
        }
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      if (moving?.pointerId !== event.pointerId) return;
      setMoving(null);
      order(moving.ids);
    },
    onPointerCancel(event: PointerEvent<HTMLButtonElement>) {
      if (moving?.pointerId === event.pointerId) setMoving(null);
    },
  });

  return (
    <Section
      id="settings-floors"
      title="Floors"
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => props.onEdit({ action: "add" })}
        >
          Add floor
        </Button>
      }
    >
      {places.floors.length === 0 ? (
        <p className="m-0 text-[13px] font-medium text-muted-foreground">
          Floors put rooms in order, such as Ground floor and First floor, and
          turn each floor's lights off at once.
        </p>
      ) : (
        <>
          <p id="settings-floors-hint" className="sr-only">
            Drag a floor by its grip, or move it with the arrow keys.
          </p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {shown.map((floor) => (
              <li
                key={floor.id}
                ref={(element) => {
                  if (element) rows.current.set(floor.id, element);
                  else rows.current.delete(floor.id);
                }}
                data-dragging={moving?.id === floor.id ? "" : undefined}
                className="flex items-center gap-3 transition-opacity data-dragging:opacity-70 motion-reduce:transition-none"
              >
                <Button
                  ref={(element) => {
                    if (element) grips.current.set(floor.id, element);
                    else grips.current.delete(floor.id);
                  }}
                  variant="grip"
                  size="icon-sm"
                  aria-label={`Move ${floor.name}`}
                  aria-describedby="settings-floors-hint"
                  onKeyDown={keys(floor.id)}
                  {...drag(floor.id)}
                  className="-ms-1.5"
                >
                  <GripVertical />
                </Button>
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
                >
                  <Layers className="size-4" />
                </span>
                <Row title={floor.name} detail={floorDetail(floor, places)} />
                <FloorMenu
                  floor={floor}
                  onEdit={(action) => props.onEdit({ action, floor })}
                />
              </li>
            ))}
          </ul>
          <p role="status" className="sr-only">
            {announcement}
          </p>
        </>
      )}
    </Section>
  );
}

function FloorMenu(props: {
  floor: Floor;
  onEdit: (action: "edit" | "remove") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${props.floor.name}: more`}
          className="ms-auto"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => props.onEdit("edit")}>
          <Pencil />
          Edit
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

// Adding or editing a floor, with its name and the rooms on it, or removing
// it once the core has said what goes with it. Checking a room on another
// floor moves it here, as its line says.
export function EditFloor(props: {
  editing?: FloorEditing;
  places: Places | undefined;
  onClose: () => void;
  onSaved: () => void;
  onRemoved: (id: string) => void;
}) {
  // What the dialog showed stays while it closes. `current` is what it
  // shows once committed, so an answer for an earlier floor is dropped.
  const [editing, setEditing] = useState(props.editing);
  if (props.editing && props.editing !== editing) setEditing(props.editing);
  const current = useRef<FloorEditing>(undefined);
  useEffect(() => {
    current.current = props.editing;
    return () => {
      current.current = undefined;
    };
  }, [props.editing]);
  const [name, setName] = useState("");
  const [onIt, setOnIt] = useState<ReadonlySet<string>>(new Set());
  const [removal, setRemoval] = useState<FloorRemoval>();
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);

  // The places as the sheet opened with them, so a change elsewhere doesn't
  // reset what someone is choosing.
  const placesRef = useRef(props.places);
  useEffect(() => {
    placesRef.current = props.places;
  });
  useEffect(() => {
    const opened = props.editing;
    const rooms = placesRef.current?.rooms ?? [];
    setName(opened?.action === "edit" ? opened.floor.name : "");
    setOnIt(
      new Set(
        opened?.action === "edit"
          ? rooms
              .filter((room) => room.floorId === opened.floor.id)
              .map((room) => room.id)
          : opened?.action === "add" && opened.roomId
            ? [opened.roomId]
            : [],
      ),
    );
    setRemoval(undefined);
    setProblem(undefined);
    setWorking(false);
    if (opened?.action !== "remove") return;
    coreJson<FloorRemoval>(
      `/api/places/floors/removal?id=${encodeURIComponent(opened.floor.id)}`,
    ).then(
      (answer) => {
        if (current.current === opened) setRemoval(answer);
      },
      (error: unknown) => {
        if (current.current === opened) setProblem(floorProblem(error));
      },
    );
  }, [props.editing]);

  const floorId = editing?.action === "add" ? null : editing?.floor.id;
  const floors = props.places?.floors ?? [];
  const rooms = props.places?.rooms ?? [];
  const taken = new Set(
    floors
      .filter((floor) => floor.id !== floorId)
      .map((floor) => floor.name.toLowerCase()),
  );
  const suggestions = suggestedFloorNames.filter(
    (each) =>
      !taken.has(each.toLowerCase()) &&
      each.toLowerCase() !== name.trim().toLowerCase(),
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setWorking(true);
    setProblem(undefined);
    try {
      if (editing.action === "remove") {
        await coreJson("/api/places/floors/remove", {
          method: "POST",
          json: { id: editing.floor.id },
        });
        props.onRemoved(editing.floor.id);
      } else {
        const id =
          editing.action === "add"
            ? (
                await coreJson<Floor>("/api/places/floors/add", {
                  method: "POST",
                  json: { name: name.trim() },
                })
              ).id
            : editing.floor.id;
        if (editing.action === "edit" && name.trim() !== editing.floor.name) {
          await coreJson("/api/places/floors/update", {
            method: "POST",
            json: { id, name: name.trim() },
          });
        }
        for (const room of rooms) {
          const wanted = onIt.has(room.id);
          if (wanted === (room.floorId === id)) continue;
          await coreJson("/api/places/rooms/update", {
            method: "POST",
            json: { id: room.id, floorId: wanted ? id : null },
          });
        }
        props.onSaved();
      }
      if (current.current === editing) props.onClose();
    } catch (error) {
      if (current.current !== editing) return;
      setWorking(false);
      setProblem(floorProblem(error));
    }
  };

  const warning = removal && floorRemovalWarning(removal);
  const title =
    editing?.action === "add"
      ? "New floor"
      : editing?.action === "edit"
        ? "Edit floor"
        : `Remove ${editing?.floor.name}?`;
  const description =
    editing?.action === "remove"
      ? !removal
        ? problem
          ? `${productName} could not say what goes with it.`
          : "Looking at what goes with it…"
        : "Its rooms keep their devices."
      : "Choose its name and the rooms on it.";

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
                <>
                  <div className="flex flex-col gap-2">
                    <Input
                      aria-label="Name"
                      value={name}
                      maxLength={60}
                      onChange={(event) => setName(event.target.value)}
                      autoFocus
                    />
                    {suggestions.length > 0 && (
                      <div
                        role="group"
                        aria-label="Suggested names"
                        className="flex flex-wrap gap-1.5"
                      >
                        {suggestions.map((each) => (
                          <Button
                            key={each}
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setName(each)}
                          >
                            {each}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-2 p-0 text-[13px] font-medium text-muted-foreground">
                      Rooms
                    </legend>
                    {rooms.length === 0 ? (
                      <p className="m-0 text-sm text-muted-foreground">
                        No rooms yet.
                      </p>
                    ) : (
                      rooms.map((room) => {
                        const elsewhere =
                          room.floorId !== null && room.floorId !== floorId
                            ? floors.find((each) => each.id === room.floorId)
                            : undefined;
                        const id = `floor-room-${room.id}`;
                        return (
                          <div
                            key={room.id}
                            className="flex items-center gap-3"
                          >
                            <Checkbox
                              id={id}
                              checked={onIt.has(room.id)}
                              onCheckedChange={(checked) =>
                                setOnIt((was) => {
                                  const next = new Set(was);
                                  if (checked === true) next.add(room.id);
                                  else next.delete(room.id);
                                  return next;
                                })
                              }
                            />
                            <label htmlFor={id} className="flex-1 text-sm">
                              {room.name}
                            </label>
                            {elsewhere && (
                              <span className="text-[13px] font-medium text-muted-foreground">
                                On {elsewhere.name}
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </fieldset>
                </>
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
              {editing?.action === "remove"
                ? working
                  ? "Removing…"
                  : "Remove floor"
                : editing?.action === "add"
                  ? "Add"
                  : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
