import type { AppInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import type { ClientInfo, Me, PersonInfo } from "@meetsanctum/auth-protocol";
import { useTemperatureUnit, type LiveFeed } from "@meetsanctum/ui-sdk";
import {
  Bot,
  Sparkles,
  Gauge,
  House,
  Layers,
  LayoutGrid,
  Lightbulb,
  List,
  MonitorSmartphone,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { AreaGroup, AreaRow } from "./components";
import { useAgents } from "./agents/data";
import { agentsTitle, assistantAppsOf } from "./agents/words";
import { useModels } from "./models/data";
import { modelsTitle, sourceName } from "./models/words";
import { coreJson } from "./core-fetch";
import { maintenanceHint } from "./maintenance";
import { peopleSummary } from "./people/words";
import { SummaryLine, summarySpoken } from "./settings-status";
import type { SystemStatus } from "./system-status";
import { useMinuteClock } from "./device-firmware";
import { roomsTitle } from "./system-apps";

// Settings' first page: what needs attention, while anything does, then a
// row for each of its areas, each opening that area's page. A row says in a
// few words how its area stands, in counts and states that change seldom,
// so the page stays calm on a shared tablet. The areas come in groups:
// the home, what's due and what happened, the apps with the AI agents, and
// the devices that open Sanctum with Sanctum itself.

/** One of Settings' areas, by the page it opens. */
type SettingsArea =
  | "household"
  | "people"
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
  const names = usePeopleNames(props.live);
  const { agents } = useAgents(props.live);
  const agentCount = (agents?.length ?? 0) + assistantAppsOf(props.apps).length;
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
        {row("people", Users, "People", peopleSummary(names ?? []))}
        {row("rooms", Layers, roomsTitle, describeRoomsAndFloors(places))}
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
          agentCount > 0
            ? counted(agentCount, "agent")
            : agents
              ? "None yet"
              : "",
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
          "Linked Devices",
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

// The household's names, once the core has said, read again with the shell.
function usePeopleNames(live: LiveFeed) {
  const [names, setNames] = useState<string[]>();
  useEffect(() => {
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const people = await coreJson<PersonInfo[]>("/api/people");
        if (current === request) setNames(people.map(({ name }) => name));
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
  return names;
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
