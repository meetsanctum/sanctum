import type { AppInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import type { ClientInfo, Me } from "@meetsanctum/auth-protocol";
import { Button, useTemperatureUnit, type LiveFeed } from "@meetsanctum/ui-sdk";
import {
  Bot,
  Sparkles,
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
import { useAgents } from "./agents/data";
import { agentsTitle } from "./agents/words";
import { useModels } from "./models/data";
import { modelsTitle, sourceName } from "./models/words";
import { coreJson } from "./core-fetch";
import { maintenanceHint } from "./maintenance";
import { SummaryLine, summarySpoken } from "./settings-status";
import type { SystemStatus } from "./system-status";
import { useMinuteClock } from "./device-firmware";

// Settings' first page: what needs attention, while anything does, then a
// row for each of its areas, each opening that area's page. A row says in a
// few words how its area stands, in counts and states that change seldom,
// so the page stays calm on a shared tablet. The areas come in groups:
// the home, what's due and what happened, the apps with the AI agents, and
// the devices that open Sanctum with Sanctum itself.

/** One of Settings' areas, by the page it opens. */
type SettingsArea =
  | "household"
  | "rooms"
  | "devices"
  | "maintenance"
  | "activity"
  | "apps"
  | "agents"
  | "ai-models"
  | "clients"
  | "system";

const unitNames = { celsius: "Celsius", fahrenheit: "Fahrenheit" } as const;

// A time zone as people say its place: "Europe/Zurich" is Zurich.
const zonePlace = (zone: string) =>
  zone.split("/").at(-1)!.replaceAll("_", " ");

const counted = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

function describeRoomsAndFloors(places: Places | undefined) {
  const rooms = places?.rooms ?? [];
  const floors = places?.floors.length ?? 0;
  const roomCount = rooms.length
    ? counted(rooms.length, "room")
    : "No rooms yet";
  if (!floors) return roomCount;

  const floorIds = new Set(rooms.map((room) => room.floorId));
  const separator =
    !floorIds.has(null) && floorIds.size === floors ? " on " : " · ";
  return `${roomCount}${separator}${counted(floors, "floor")}`;
}

export function SettingsOverview(props: {
  apps: readonly AppInfo[];
  devices: readonly DeviceInfo[];
  places: Places | undefined;
  live: LiveFeed;
  me?: Me;
  status: SystemStatus | undefined;
  statusFailed: boolean;
  open: (area: SettingsArea) => void;
}) {
  const { places } = props;
  const now = useMinuteClock();
  const unit = useTemperatureUnit() ?? "celsius";
  const others = useOtherClients(props.live);
  const { agents } = useAgents(props.live);
  const agentCount = agents?.length;
  const models = useModels(props.live).info?.sources;
  const modelInUse = models?.find((source) => source.inUse);
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
          describeRoomsAndFloors(places),
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
        {row(
          "agents",
          Bot,
          agentsTitle,
          agentCount === undefined
            ? ""
            : agentCount === 0
              ? "None yet"
              : counted(agentCount, "agent"),
        )}
        {row(
          "ai-models",
          Sparkles,
          modelsTitle,
          models === undefined
            ? ""
            : modelInUse
              ? sourceName(modelInUse)
              : models.length === 0
                ? "None yet"
                : "None in use",
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
function useOtherClients(live: LiveFeed) {
  const [others, setOthers] = useState<number>();
  useEffect(() => {
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const clients = await coreJson<ClientInfo[]>("/api/auth/clients");
        if (current === request) {
          setOthers(clients.filter((client) => !client.current).length);
        }
      } catch {
        // The next shell refresh can ask again.
      }
    };
    void refresh();
    const stop = live.subscribe({ refresh: () => void refresh() });
    return () => {
      request++;
      stop();
    };
  }, [live]);
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
