import { Button } from "@meetsanctum/ui-sdk";
import { House, PanelLeft } from "lucide-react";
import type { ComponentProps, ReactNode, Ref } from "react";

import { SidebarHeading, SidebarItem } from "./sidebar-item";
import { UserMenu, type Account } from "./user-menu";

/** A dashboard as the sidebar lists it: Home with its house, the others with their background as a swatch. */
export type SidebarDashboard = {
  id: string;
  name: string;
  background: string;
  home: boolean;
  current: boolean;
  onSelect: () => void;
};

// The sidebar's toggle, a ghost in the top bar's size like its others: first
// in the top bar and at the end of the floating sidebar's top row. It stays
// a ghost while the sidebar is shown, which marks itself.
export function SidebarToggle({
  label,
  ...props
}: { label: string } & Omit<
  ComponentProps<typeof Button>,
  "variant" | "size" | "children"
>) {
  return (
    <Button {...props} variant="ghost" size="bar" aria-label={label}>
      <PanelLeft aria-hidden="true" />
    </Button>
  );
}

// What the sidebar holds, docked beside the page or floating over it: its
// top row, where the macOS traffic lights sit and which moves the window,
// with the floating sidebar's own toggle at its end; the pinned apps, Apps
// last (sidebar-pins.tsx); the home's dashboards under Dashboards, Home
// first with its house and the others with their background as a swatch;
// then the categories and the rooms (place-pages.tsx), each under its own
// heading; and on personal devices the person's avatar at the foot.
export function SidebarContent(props: {
  /** The floating sidebar's own toggle. */
  toggle?: { label: string; onClick: () => void };
  pins: ReactNode;
  dashboards: SidebarDashboard[];
  /** The categories and rooms. */
  children?: ReactNode;
  account?: Account;
  /** An inactive sidebar closes anything opened from it. */
  isInert?: boolean;
  /** The account's menu opened or closed, which keeps a floating sidebar in. */
  onMenuOpenChange?: (open: boolean) => void;
  navRef?: Ref<HTMLElement>;
}) {
  return (
    <>
      <div className="sidebar-top flex h-10 shrink-0 items-center justify-end">
        {props.toggle && (
          <SidebarToggle
            label={props.toggle.label}
            onClick={props.toggle.onClick}
            className="me-1"
          />
        )}
      </div>
      <nav
        ref={props.navRef}
        aria-label="Pinned apps, dashboards, categories and rooms"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none]"
      >
        {props.pins}
        <SidebarHeading>Dashboards</SidebarHeading>
        {props.dashboards.map((dashboard) => (
          <SidebarItem
            key={dashboard.id}
            {...(dashboard.home
              ? { icon: House }
              : { swatch: dashboard.background })}
            name={dashboard.name}
            current={dashboard.current}
            onSelect={dashboard.onSelect}
          />
        ))}
        {props.children}
      </nav>
      {props.account && (
        <UserMenu
          {...props.account}
          isInert={props.isInert}
          onOpenChange={props.onMenuOpenChange}
        />
      )}
    </>
  );
}
