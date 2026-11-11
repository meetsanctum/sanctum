import type { DashboardInfo } from "@meetsanctum/app-sdk";
import { Button, Input } from "@meetsanctum/ui-sdk";
import {
  EllipsisVertical,
  LayoutDashboard,
  Pencil,
  Settings,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

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
import { SidebarToggle } from "./sidebar";

// The top bar, at the top of the page: the sidebar's toggle, then on a
// dashboard its name and at the right end its ⋮ menu, or while Home is
// edited Edit Home and Done, and elsewhere the place where an app's page
// puts its title and its own buttons (PageBar in @meetsanctum/ui-sdk). There
// is no Back: the sidebar leads everywhere, Apps included. Its icon buttons
// are ghosts in Button's bar size, 36 px with the pins' 9 px corners, and
// its title is 20 / 28 Regular. In the desktop app on macOS it moves the
// window.
export function TopBar(props: {
  sidebarTrigger: RefObject<HTMLButtonElement | null>;
  /** The sidebar is docked, or floats over the page. */
  sidebarShown: boolean;
  /** It is docked: the toggle hides it. */
  sidebarDocked: boolean;
  onSidebar: () => void;
  /** The dashboard on show, if one is. */
  dashboard?: DashboardInfo;
  /** The connection veil covers the screen. */
  isVeiled?: boolean;
  onRename: (id: string, name: string) => Promise<unknown>;
  /** Opens Edit Home, dimmed while the home has no devices; in Home's menu only. */
  onEditHome?: { disabled: boolean; open: () => void };
  /** Home is being edited, until Done. */
  editingHome?: { onDone: () => void };
  /** Where the page on show puts its title and buttons, off a dashboard. */
  pageSlot?: (element: HTMLDivElement | null) => void;
  /**
   * The settings of the app whose page is on show, opened by the same
   * button at the end of the bar on every app page.
   */
  appSettings?: { name: string; open: () => void };
}) {
  return (
    <header className="top-bar">
      <SidebarToggle
        ref={props.sidebarTrigger}
        label={props.sidebarDocked ? "Hide the sidebar" : "Show the sidebar"}
        aria-expanded={props.sidebarShown}
        onClick={props.onSidebar}
      />
      {props.dashboard && props.editingHome && (
        <>
          <p className="m-0 min-w-0 truncate ps-2 text-xl leading-7 font-normal text-white">
            Edit {props.dashboard.name}
          </p>
          <Button
            variant="outline"
            onClick={props.editingHome.onDone}
            className="ms-auto"
          >
            Done
          </Button>
        </>
      )}
      {props.dashboard && !props.editingHome && (
        <>
          <p className="m-0 min-w-0 truncate ps-2 text-xl leading-7 font-normal text-white">
            {props.dashboard.name}
          </p>
          {/* Its menu and dialog float over the page: they close under the
              veil, and when the dashboard they act on is gone. */}
          {!props.isVeiled && (
            <DashboardMenu
              key={props.dashboard.id}
              dashboard={props.dashboard}
              onRename={props.onRename}
              onEditHome={props.onEditHome}
            />
          )}
        </>
      )}
      {!props.dashboard && (
        <div
          ref={props.pageSlot}
          className="flex min-w-0 flex-1 items-center"
        />
      )}
      {/* After the page's own buttons, so it is always in the same place. */}
      {!props.dashboard && props.appSettings && (
        <Button
          variant="ghost"
          size="bar"
          aria-label={`${props.appSettings.name} settings`}
          onClick={props.appSettings.open}
          // Its icon, not its square, ends at the page's 24 px edge.
          className="ms-2 -me-2.25"
        >
          <Settings aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}

// The ⋮ menu at the right end of the top bar, on a dashboard: Edit Home on
// Home's, then Rename. Every client offers it, shared tablets included: the
// dashboards are the household's.
function DashboardMenu(props: {
  dashboard: DashboardInfo;
  onRename: (id: string, name: string) => Promise<unknown>;
  onEditHome?: { disabled: boolean; open: () => void };
}) {
  const [renaming, setRenaming] = useState<DashboardInfo>();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="bar"
            aria-label={`${props.dashboard.name}: more`}
            // Its icon, not its square, ends at the page's 24 px edge.
            className="ms-auto -me-2.25"
          >
            <EllipsisVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-44">
          {props.dashboard.kind === "home" && props.onEditHome && (
            <DropdownMenuItem
              disabled={props.onEditHome.disabled}
              onSelect={props.onEditHome.open}
            >
              <LayoutDashboard />
              <span className="truncate">Edit {props.dashboard.name}</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setRenaming(props.dashboard)}>
            <Pencil />
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDashboard
        dashboard={renaming}
        onRename={props.onRename}
        onClose={() => setRenaming(undefined)}
        trigger={trigger}
      />
    </>
  );
}

// Its name, written through the core, which tells every client.
function RenameDashboard(props: {
  dashboard?: DashboardInfo;
  onRename: (id: string, name: string) => Promise<unknown>;
  onClose: () => void;
  // Where focus returns: the menu that opened it has closed by then.
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  // What the dialog showed stays while it closes.
  const last = useRef<DashboardInfo>(undefined);
  if (props.dashboard) last.current = props.dashboard;
  const dashboard = last.current;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  // Opening or closing it outdates a rename still out.
  const attempt = useRef(0);

  useEffect(() => {
    attempt.current += 1;
    setName(props.dashboard?.name ?? "");
    setProblem(undefined);
    setWorking(false);
  }, [props.dashboard]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dashboard) return;
    // The same name again changes nothing.
    if (name.trim() === dashboard.name) {
      props.onClose();
      return;
    }
    const current = ++attempt.current;
    setWorking(true);
    setProblem(undefined);
    try {
      await props.onRename(dashboard.id, name.trim());
      if (current === attempt.current) props.onClose();
    } catch {
      if (current !== attempt.current) return;
      setProblem("That did not work. Try again.");
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={!!props.dashboard}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          props.trigger.current?.focus();
        }}
      >
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Rename this dashboard</DialogTitle>
            <DialogDescription>
              The name shows on every device in the home.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
          />
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={working || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
