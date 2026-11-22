import type { AgentInfo } from "@meetsanctum/auth-protocol";
import type { AppInfo } from "@meetsanctum/app-sdk";
import { Button, Input } from "@meetsanctum/ui-sdk";
import {
  Bot,
  ChevronRight,
  EllipsisVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { useAuthAttempt } from "../auth/use-auth-attempt";
import { Row, Section } from "../components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { coreJson } from "../core-fetch";
import { AddAgent } from "./add-agent";
import { canUseTitle } from "./can-use-page";
import { useAgents, useAiCanUse } from "./data";
import { agentDetail, onCount } from "./words";

// Settings → AI agents: the AI programs on computers at home that use the
// home over MCP, each with who added it and when it was last seen, and a
// menu to rename or remove it, then what they can use. Add an agent starts
// a setup whose prompt the person pastes into the agent. Every client sees
// and manages every agent.

export const agentsSettingsPage = "agents";
export const agentsTitle = "AI agents";

type Editing = { action: "rename" | "remove"; agent: AgentInfo };

export function AgentsPage(props: {
  apps: readonly AppInfo[];
  // Opens What AI agents can use.
  onOpenCanUse: () => void;
  // The page's way back.
  page: ReactNode;
}) {
  const { agents, refresh } = useAgents();
  const { canUse } = useAiCanUse();
  const [editing, setEditing] = useState<Editing>();
  const [adding, setAdding] = useState(false);
  const update = () => void refresh().catch(() => undefined);
  const switchable = canUse?.areas.filter((area) => !area.always) ?? [];

  return (
    <>
      <Section
        id="settings-agents"
        title={agentsTitle}
        action={<Button onClick={() => setAdding(true)}>Add an agent</Button>}
        page={props.page}
      >
        {agents?.length === 0 && (
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            Let an AI program on a computer at home, such as Claude Code or
            Codex, use your home: turn on lights, run moods and answer
            questions. You choose what it can use.
          </p>
        )}
        {agents && agents.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
                >
                  <Bot className="size-4" />
                </span>
                {/* Its line wraps rather than cut short, since when it was
                    added tells two agents of the same name apart. */}
                <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
                  <span className="truncate text-sm font-medium">
                    {agent.name}
                  </span>
                  <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                    {agentDetail(agent, agents)}
                  </span>
                </span>
                <AgentMenu
                  agent={agent}
                  onEdit={(action) => setEditing({ action, agent })}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <ul className="m-0 flex shrink-0 list-none flex-col rounded-lg bg-card p-1.5 text-card-foreground">
        <li>
          <Button
            variant="row"
            size="row"
            type="button"
            onClick={props.onOpenCanUse}
          >
            <Row
              title={canUseTitle}
              detail={canUse ? onCount(switchable) : ""}
            />
            <ChevronRight
              aria-hidden="true"
              className="ms-auto size-4 shrink-0 text-muted-foreground"
            />
          </Button>
        </li>
      </ul>
      <EditAgent
        editing={editing}
        onClose={() => setEditing(undefined)}
        onDone={update}
      />
      <AddAgent
        open={adding}
        onOpenChange={setAdding}
        apps={props.apps}
        canUse={canUse}
        onConnected={update}
      />
    </>
  );
}

function AgentMenu(props: {
  agent: AgentInfo;
  onEdit: (action: Editing["action"]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${props.agent.name}: more`}
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

// Renaming an agent, or removing it after saying what that does. An agent
// is a client of its own kind, so it's renamed and removed as clients are.
function EditAgent(props: {
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
    setName(props.editing?.agent.name ?? "");
    setProblem(undefined);
    setWorking(false);
  }, [props.editing, cancel]);

  const close = () => {
    cancel();
    props.onClose();
  };

  const renaming = editing?.action === "rename";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const signal = start();
    setWorking(true);
    setProblem(undefined);
    try {
      await coreJson(
        renaming ? "/api/auth/clients/rename" : "/api/auth/clients/revoke",
        {
          method: "POST",
          signal,
          json: renaming
            ? { id: editing.agent.id, name: name.trim() }
            : { id: editing.agent.id },
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

  return (
    <Dialog
      open={!!props.editing}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent showCloseButton={renaming}>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>
              {renaming
                ? "Rename this agent"
                : `Remove ${editing?.agent.name}?`}
            </DialogTitle>
            <DialogDescription>
              {renaming
                ? "The name shows here and in the activity log."
                : "It stops working at once, though a command it already sent may still finish. To use it again, add it again."}
            </DialogDescription>
          </DialogHeader>
          {renaming && (
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
            <Button
              type="button"
              variant="outline"
              autoFocus={!renaming}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={renaming ? "default" : "destructive"}
              disabled={working || (renaming && !name.trim())}
            >
              {renaming ? "Save" : "Remove"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
