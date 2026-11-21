import type { AppInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import type { ClientInfo, Me } from "@meetsanctum/auth-protocol";
import { Button, useTemperatureUnit } from "@meetsanctum/ui-sdk";
import {
  ChevronRight,
  Gauge,
  House,
  Layers,
  LayoutGrid,
  Lightbulb,
  List,
  MonitorSmartphone,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Row } from "./components";
import { coreJson } from "./core-fetch";
import { maintenanceHint } from "./maintenance";
import { SummaryLine, summarySpoken } from "./settings-status";
import type { SystemStatus } from "./system-status";
import { useMinuteClock } from "./device-firmware";

// Settings' first page: what needs attention, while anything does, then a
// row for each of its areas, each opening that area's page. A row says in a
// few words how its area stands, in counts and states that change seldom,
// so the page stays calm on a shared tablet. The areas come in groups:
// the home, what's due and what happened, the apps, and the devices that
// open Sanctum with Sanctum itself.

/** One of Settings' areas, by the page it opens. */
export type SettingsArea =
  | "household"
  | "rooms"
  | "devices"
  | "maintenance"
  | "activity"
  | "apps"
  | "clients"
  | "system";

const unitNames = { celsius: "Celsius", fahrenheit: "Fahrenheit" } as const;

// A time zone as people say its place: "Europe/Zurich" is Zurich.
const zonePlace = (zone: string) =>
  zone.split("/").at(-1)!.replaceAll("_", " ");

const counted = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export function SettingsOverview(props: {
  apps: readonly AppInfo[];
  devices: readonly DeviceInfo[];
  places: Places | undefined;
  me?: Me;
  status: SystemStatus | undefined;
  statusFailed: boolean;
  open: (area: SettingsArea) => void;
}) {
  const { places } = props;
  const now = useMinuteClock();
  const unit = useTemperatureUnit() ?? "celsius";
  const others = useOtherClients();
  const rooms = places?.rooms.length ?? 0;
  const floors = places?.floors.length ?? 0;
  const updates = props.apps.filter((app) => app.waiting).length;
  const row = (
    area: SettingsArea,
    icon: LucideIcon,
    title: string,
    detail: ReactNode,
    spoken?: string,
  ) => (
    <AreaRow
      icon={icon}
      title={title}
      detail={detail}
      spoken={spoken}
      onOpen={() => props.open(area)}
    />
  );
  return (
    <nav aria-label="Settings" className="flex shrink-0 flex-col gap-4">
      <AreaGroup>
        {row(
          "household",
          House,
          "Household",
          places
            ? [
                places.home.name,
                zonePlace(places.home.timeZone),
                unitNames[places.home.temperatureUnit],
              ].join(" · ")
            : "",
        )}
        {row(
          "rooms",
          Layers,
          "Rooms and floors",
          rooms === 0
            ? "No rooms yet"
            : floors === 0
              ? counted(rooms, "room")
              : `${counted(rooms, "room")} on ${counted(floors, "floor")}`,
        )}
        {row(
          "devices",
          Lightbulb,
          "Devices",
          props.devices.length === 0
            ? "None yet"
            : counted(props.devices.length, "device"),
        )}
      </AreaGroup>
      <AreaGroup>
        {row(
          "maintenance",
          Wrench,
          "Maintenance",
          maintenanceHint(props.devices, now) ?? "Nothing to do",
        )}
        {row("activity", List, "Activity", "Who did what in the home")}
      </AreaGroup>
      <AreaGroup>
        {row(
          "apps",
          LayoutGrid,
          "Apps",
          [
            counted(props.apps.length, "app"),
            updates > 0 ? `${counted(updates, "update")} waiting` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        )}
      </AreaGroup>
      <AreaGroup>
        {row(
          "clients",
          MonitorSmartphone,
          "Clients",
          others === undefined
            ? (props.me?.client.name ?? "")
            : others === 0
              ? "This device"
              : `This device and ${counted(others, "other")}`,
        )}
        {row(
          "system",
          Gauge,
          "System",
          <SummaryLine
            status={props.status}
            failed={props.statusFailed}
            unit={unit}
            first
          />,
          summarySpoken(props.status, unit, props.statusFailed),
        )}
      </AreaGroup>
    </nav>
  );
}

// How many clients there are besides this one, once the core has said.
function useOtherClients() {
  const [others, setOthers] = useState<number>();
  useEffect(() => {
    let current = true;
    coreJson<ClientInfo[]>("/api/auth/clients")
      .then((clients) => {
        if (current) {
          setOthers(clients.filter((client) => !client.current).length);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return others;
}

// A card of areas that belong together, set apart from the next by space
// alone.
function AreaGroup(props: { children: ReactNode }) {
  return (
    <ul className="m-0 flex list-none flex-col rounded-lg bg-card p-1.5 text-card-foreground">
      {props.children}
    </ul>
  );
}

// An area: its icon, its name over how it stands, and the chevron that
// says it opens a page.
function AreaRow(props: {
  icon: LucideIcon;
  title: string;
  detail: ReactNode;
  // What a screen reader hears of a detail that isn't words alone.
  spoken?: string;
  onOpen: () => void;
}) {
  const Icon = props.icon;
  return (
    <li>
      <Button
        variant="row"
        size="row"
        type="button"
        onClick={props.onOpen}
        aria-label={
          props.spoken ? `${props.title}: ${props.spoken}` : undefined
        }
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
        >
          <Icon className="size-4" />
        </span>
        {typeof props.detail === "string" ? (
          <Row title={props.title} detail={props.detail} />
        ) : (
          <span className="flex min-w-0 flex-col gap-px leading-tight">
            <span className="truncate text-sm font-medium">{props.title}</span>
            {props.detail}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className="ms-auto size-4 shrink-0 text-muted-foreground"
        />
      </Button>
    </li>
  );
}
