import type { ClientInfo, PersonInfo } from "@meetsanctum/auth-protocol";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { EllipsisVertical, House, Pencil, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
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
import { platformNames } from "./platforms";

// Settings → Clients: every client with its kind, person, platform and
// last-seen time, or Connected now while it is. Every client sees and
// manages every client and adds shared devices, shared ones too. Removing a
// client signs it out at once.

const minute = 60_000;

// When a client was last seen, as people say it. A client that never used
// its token, such as a shared device whose token was lost on the way, is
// marked as never seen.
export function seenText(lastSeenAt: string | null, now = new Date()) {
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
  return `Seen on ${new Date(lastSeenAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })}`;
}

export function clientDetail(
  client: ClientInfo,
  person: PersonInfo | undefined,
  now?: Date,
) {
  return [
    client.kind === "shared" ? "Shared" : (person?.name ?? "Personal"),
    platformNames[client.platform],
    client.current
      ? "This device"
      : client.connectedSince
        ? "Connected now"
        : seenText(client.lastSeenAt, now),
  ].join(" · ");
}

type Editing = { action: "rename" | "remove"; client: ClientInfo };

export function ClientsSection() {
  const [clients, setClients] = useState<ClientInfo[]>();
  const [people, setPeople] = useState<PersonInfo[]>([]);
  const [editing, setEditing] = useState<Editing>();
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    const [nextClients, nextPeople] = await Promise.all([
      coreJson<ClientInfo[]>("/api/auth/clients"),
      coreJson<PersonInfo[]>("/api/people"),
    ]);
    setClients(nextClients);
    setPeople(nextPeople);
  }, []);

  // A device approved here shows up once it collects its token, and
  // last-seen times move on.
  useEffect(() => {
    const update = () => void refresh().catch(() => undefined);
    update();
    const timer = window.setInterval(update, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <Section
      id="settings-clients"
      title="Clients"
      action={
        <Button size="sm" onClick={() => setAdding(true)}>
          Add a shared device
        </Button>
      }
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
                  detail={clientDetail(client, person)}
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
      <EditClient
        editing={editing}
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
        {/* Signing out of this device is in the account menu. */}
        {!props.client.current && (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => props.onEdit("remove")}
          >
            <Trash2 />
            Remove
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Renaming a client, or removing it after saying what that does.
function EditClient(props: {
  editing?: Editing;
  onClose: () => void;
  onDone: () => void;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<Editing>(undefined);
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
                ? "Rename this client"
                : `Remove ${editing?.client.name}?`}
            </DialogTitle>
            <DialogDescription>
              {editing?.action === "rename"
                ? "The name shows here and in the activity log."
                : shared
                  ? "It is signed out at once. To add it again, choose “This is a shared device” on it and approve its new code."
                  : "It is signed out at once, and its person signs in again to use it."}
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
              {editing?.action === "rename" ? "Save" : "Remove"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
