import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import type {
  ClientInfo,
  PersonInfo,
  SetClientDrawing,
} from "@meetsanctum/auth-protocol";
import { Button, Input, useHomeClock } from "@meetsanctum/ui-sdk";
import { EllipsisVertical, Gauge, House, LogOut, Pencil } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { ApproveDevice } from "./approve-device";
import { useAuthAttempt } from "./auth/use-auth-attempt";
import { Avatar, Row, Section } from "./components";
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
import { coreJson } from "./core-fetch";
import { firstName, usedText } from "./people/words";
import { platformNames } from "./platforms";
import { ClientDrawing, drawnText } from "./settings-client-drawing";
import { everyWhileShown } from "./while-shown";

// Settings → Linked Devices: every device that shows the home, with its
// person or Shared, its platform and when it was last used, in the words a
// person's page uses: to the day, never a time, since shared screens show
// this page too. Every device sees and manages every linked device and adds
// shared ones. Signing one out ends it at once.

const minute = 60_000;

// When a client was last seen, as people say it. A client that never used
// its token, such as a shared device whose token was lost on the way, is
// marked as never seen.
export function seenText(
  clock: HomeClock,
  lastSeenAt: string | null,
  now = new Date(),
) {
  if (!lastSeenAt) {
    return "Never seen";
  }
  const ago = now.getTime() - new Date(lastSeenAt).getTime();
  if (ago < 2 * minute) {
    return "Seen just now";
  }
  if (ago < 60 * minute) {
    return `Seen ${Math.floor(ago / minute)} minutes ago`;
  }
  if (ago < 24 * 60 * minute) {
    const hours = Math.floor(ago / (60 * minute));
    return hours === 1 ? "Seen an hour ago" : `Seen ${hours} hours ago`;
  }
  return `Seen on ${clock.dayText(new Date(lastSeenAt))}`;
}

export function clientDetail(
  clock: HomeClock,
  client: ClientInfo,
  person: PersonInfo | undefined,
  now?: Date,
) {
  return [
    client.kind === "shared" ? "Shared" : (person?.name ?? "Personal"),
    platformNames[client.platform],
    usedText(clock, client, now),
    drawnText(client),
  ]
    .filter(Boolean)
    .join(" · ");
}

type EditNameOrRemove = {
  action: "rename" | "remove";
  client: ClientInfo;
};
type Editing = EditNameOrRemove | { action: "drawing"; client: ClientInfo };

export function ClientsSection(props: {
  // The way back of Settings' Linked Devices page, which it is the whole of.
  page?: ReactNode;
}) {
  const clock = useHomeClock();
  const [clients, setClients] = useState<ClientInfo[]>();
  const [people, setPeople] = useState<PersonInfo[]>([]);
  const [editing, setEditing] = useState<Editing>();
  const [adding, setAdding] = useState(false);
  const refreshId = useRef(0);
  const lastAppliedRefresh = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    const [nextClients, nextPeople] = await Promise.all([
      coreJson<ClientInfo[]>("/api/auth/clients"),
      coreJson<PersonInfo[]>("/api/people"),
    ]);
    if (id < lastAppliedRefresh.current) return;
    lastAppliedRefresh.current = id;
    setClients(nextClients);
    setPeople(nextPeople);
  }, []);

  // A saved switch shows at once, a read already on its way is let go,
  // since it can hold the old value, and the list read afresh, in case
  // another client changed something meanwhile. Only the switch pressed is
  // taken from the save's answer: the other may have changed since.
  const drawingChanged = (saved: SetClientDrawing) => {
    lastAppliedRefresh.current = ++refreshId.current;
    setClients((current) =>
      current?.map((client) =>
        client.id === saved.id
          ? {
              ...client,
              reduceEffects: saved.reduceEffects ?? client.reduceEffects,
              reduceMotion: saved.reduceMotion ?? client.reduceMotion,
            }
          : client,
      ),
    );
    void refresh().catch(() => undefined);
  };

  // A device approved here shows up once it collects its token, and
  // last-seen times move on.
  useEffect(() => {
    const update = () => void refresh().catch(() => undefined);
    update();
    const stopPolling = everyWhileShown(5_000, update);
    return () => stopPolling();
  }, [refresh]);

  return (
    <Section
      id="settings-clients"
      title="Linked Devices"
      action={
        <Button onClick={() => setAdding(true)}>Add a shared device</Button>
      }
      page={props.page ?? null}
    >
      {clients && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {clients.map((client) => {
            const person = people.find(({ id }) => id === client.personId);
            return (
              <li key={client.id} className="flex items-center gap-3">
                {person ? (
                  <Avatar name={person.name} colour={person.colour} />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
                  >
                    <House className="size-4" />
                  </span>
                )}
                <Row
                  title={client.name}
                  detail={clientDetail(clock, client, person)}
                />
                <ClientMenu
                  client={client}
                  onEdit={(action) => setEditing({ action, client })}
                />
              </li>
            );
          })}
        </ul>
      )}
      <ClientDrawing
        client={
          editing?.action === "drawing"
            ? (clients?.find(({ id }) => id === editing.client.id) ??
              editing.client)
            : undefined
        }
        onClose={() => setEditing(undefined)}
        onChanged={drawingChanged}
      />
      <EditClient
        editing={editing?.action === "drawing" ? undefined : editing}
        people={people}
        onClose={() => setEditing(undefined)}
        onDone={() => void refresh().catch(() => undefined)}
      />
      <ApproveDevice
        open={adding}
        onOpenChange={setAdding}
        onApproved={() => void refresh().catch(() => undefined)}
      />
    </Section>
  );
}

function ClientMenu(props: {
  client: ClientInfo;
  onEdit: (action: Editing["action"]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${props.client.name}: more`}
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
        <DropdownMenuItem onSelect={() => props.onEdit("drawing")}>
          <Gauge />
          Effects and motion
        </DropdownMenuItem>
        {/* Signing out of this device is in the account menu. */}
        {!props.client.current && (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => props.onEdit("remove")}
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Renaming a linked device, or signing it out after saying what that does.
function EditClient(props: {
  editing?: EditNameOrRemove;
  people: readonly PersonInfo[];
  onClose: () => void;
  onDone: () => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<EditNameOrRemove>(undefined);
  if (props.editing) last.current = props.editing;
  const editing = last.current;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const { start, cancel } = useAuthAttempt();

  useEffect(() => {
    cancel();
    setName(props.editing?.client.name ?? "");
    setProblem(undefined);
    setWorking(false);
  }, [props.editing, cancel]);

  const close = () => {
    cancel();
    props.onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const signal = start();
    setWorking(true);
    setProblem(undefined);
    try {
      await coreJson(
        editing.action === "rename"
          ? "/api/auth/clients/rename"
          : "/api/auth/clients/revoke",
        {
          method: "POST",
          signal,
          json:
            editing.action === "rename"
              ? { id: editing.client.id, name: name.trim() }
              : { id: editing.client.id },
        },
      );
      signal.throwIfAborted();
      props.onDone();
      props.onClose();
    } catch {
      if (signal.aborted) return;
      setProblem("That did not work. Try again.");
      setWorking(false);
    }
  };

  const shared = editing?.client.kind === "shared";
  const person = props.people.find(({ id }) => id === editing?.client.personId);
  return (
    <Dialog
      open={!!props.editing}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>
              {editing?.action === "rename"
                ? "Rename this device"
                : `Sign out ${editing?.client.name}?`}
            </DialogTitle>
            <DialogDescription>
              {editing?.action === "rename"
                ? "The name shows here and in the activity log."
                : shared
                  ? "To use it again, choose your home on it, then Everyone at home, and approve its new code."
                  : `${person ? firstName(person.name) : "Its person"} signs in again to use it.`}
            </DialogDescription>
          </DialogHeader>
          {editing?.action === "rename" && (
            <Input
              aria-label="Name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          )}
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={editing?.action === "remove" ? "destructive" : "default"}
              disabled={
                working || (editing?.action === "rename" && !name.trim())
              }
            >
              {editing?.action === "rename" ? "Save" : "Sign out"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
