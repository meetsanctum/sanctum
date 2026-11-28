import type { Floor, FloorRemoval, Places } from "@meetsanctum/app-sdk";
import { Button, Input, Problem } from "@meetsanctum/ui-sdk";
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
import { list } from "@meetsanctum/app-sdk/words";

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
import { problemReason } from "./device-parts";

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

/** A floor's line: the rooms on it by name. */
export function floorDetail(floor: Floor, places: Places): string {
  const rooms = places.rooms
    .filter((room) => room.floorId === floor.id)
    .map((room) => room.name);
  return rooms.length === 0 ? "No rooms yet" : list("en", rooms);
}

/** What removing a floor takes with it, a sentence each. */
export function floorRemovalWarning(removal: FloorRemoval): string[] {
  const lines: string[] = [];
  const rooms = removal.rooms.map((room) => room.name);
  if (rooms.length > 0) {
    lines.push(
      `${list("en", rooms)} ${rooms.length === 1 ? "stays" : "stay"}, on no floor.`,
    );
  }
  if (removal.workflows.length > 0) {
    const names = list(
      "en",
      removal.workflows.map((each) => `“${each.name}”`),
    );
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
  const ordered = ids.flatMap((id) => {
    const floor = places.floors.find((each) => each.id === id);
    return floor ? [floor] : [];
  });
  // Another client may have added a floor since this order was chosen.
  const added = places.floors.filter((floor) => !ids.includes(floor.id));
  const floors = [...ordered, ...added].map((floor, level) => ({
    ...floor,
    level,
  }));
  return { ...places, floors };
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
  const shown = moving ? inOrder(places, moving.ids).floors : places.floors;
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
      const current = shown.map((floor) => floor.id);
      for (const other of current) {
        if (other === id) continue;
        const box = rows.current.get(other)?.getBoundingClientRect();
        if (box && event.clientY >= box.top && event.clientY <= box.bottom) {
          const next = current.filter((each) => each !== id);
          next.splice(current.indexOf(other), 0, id);
          setMoving({ ...moving, ids: next });
          break;
        }
      }
    },
    onPointerUp(event: PointerEvent<HTMLButtonElement>) {
      if (moving?.pointerId !== event.pointerId) return;
      setMoving(null);
      order(inOrder(places, moving.ids).floors.map((floor) => floor.id));
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
  // What failed, said in the dialog; `retry` when what goes with a floor
  // couldn't be worked out and can be asked again.
  const [problem, setProblem] = useState<{
    title: string;
    reason: string;
    retry?: boolean;
  }>();
  const [working, setWorking] = useState(false);
  // Keep successful writes for this opening: retrying a partial save must
  // reuse its floor, and untouched room choices must leave live changes alone.
  const draft = useRef<{ floor?: Floor; rooms: Set<string> }>({
    rooms: new Set(),
  });

  const check = (opened: Extract<FloorEditing, { floor: Floor }>) => {
    setProblem(undefined);
    coreJson<FloorRemoval>(
      `/api/places/floors/removal?id=${encodeURIComponent(opened.floor.id)}`,
    ).then(
      (answer) => {
        if (current.current === opened) setRemoval(answer);
      },
      (error: unknown) => {
        if (current.current === opened)
          setProblem({
            title: `Couldn't check what goes with ${opened.floor.name}`,
            reason: problemReason(error),
            // Gone already: there is nothing to check again.
            retry: !(error instanceof CoreError && error.code === "not_found"),
          });
      },
    );
  };

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
    const assigned = new Set(
      opened?.action === "edit"
        ? rooms
            .filter((room) => room.floorId === opened.floor.id)
            .map((room) => room.id)
        : [],
    );
    draft.current = {
      floor: opened && opened.action !== "add" ? opened.floor : undefined,
      rooms: assigned,
    };
    const selected = new Set(assigned);
    if (opened?.action === "add" && opened.roomId) selected.add(opened.roomId);
    setOnIt(selected);
    setRemoval(undefined);
    setProblem(undefined);
    setWorking(false);
    if (opened?.action === "remove") check(opened);
    // Only when it opens: check is new on every render.
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
    if (!editing || working || current.current !== editing) return;
    if (editing.action === "remove" && !removal) return;
    const saving = draft.current;
    const wantedName = name.trim();
    let failureTitle =
      editing.action === "remove"
        ? `${editing.floor.name} wasn't removed`
        : `Couldn't add ${wantedName}`;
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
        if (!saving.floor) {
          saving.floor = await coreJson<Floor>("/api/places/floors/add", {
            method: "POST",
            json: { name: wantedName },
          });
        }
        const { id } = saving.floor;
        if (wantedName !== saving.floor.name) {
          failureTitle = `${saving.floor.name} wasn't renamed`;
          saving.floor = await coreJson<Floor>("/api/places/floors/update", {
            method: "POST",
            json: { id, name: wantedName },
          });
        }
        for (const room of rooms) {
          const wanted = onIt.has(room.id);
          if (wanted === saving.rooms.has(room.id)) continue;
          failureTitle = `The floor for ${room.name} wasn't changed`;
          await coreJson("/api/places/rooms/update", {
            method: "POST",
            json: { id: room.id, floorId: wanted ? id : null },
          });
          if (wanted) saving.rooms.add(room.id);
          else saving.rooms.delete(room.id);
        }
        props.onSaved();
      }
      if (current.current === editing) props.onClose();
    } catch (error) {
      props.onSaved();
      if (current.current !== editing) return;
      setWorking(false);
      setProblem({
        title: failureTitle,
        reason: problemReason(error),
      });
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
      ? !removal && !problem
        ? "Looking at what goes with it…"
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
                      // A home with many rooms scrolls them, so the sheet's
                      // buttons stay on screen.
                      <div className="-mx-1 flex max-h-[min(18rem,40dvh)] flex-col gap-2 overflow-y-auto px-1 py-0.5">
                        {rooms.map((room) => {
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
                        })}
                      </div>
                    )}
                  </fieldset>
                </>
              )}
          {problem && <Problem title={problem.title}>{problem.reason}</Problem>}
          {/* Asks again what goes with it, apart from Remove. */}
          {editing?.action === "remove" && problem?.retry && (
            <Button
              type="button"
              variant="outline"
              className="-mt-2 self-start"
              onClick={() => {
                if (current.current === editing) check(editing);
              }}
            >
              Try again
            </Button>
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
              onClick={(event) => {
                // A double click's second click never removes: once Try
                // again is answered the dialog shrinks, and Remove can move
                // under the pointer.
                if (editing?.action === "remove" && event.detail > 1)
                  event.preventDefault();
              }}
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
