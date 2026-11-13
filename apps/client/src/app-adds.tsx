import {
  entityReadPermission,
  type AppInfo,
  type CapabilityKind,
  type DeviceInfo,
  type EntityInfo,
  type PieceWords,
  type Room,
  type StaticManifest,
  type WorkflowInfo,
} from "@meetsanctum/app-sdk";
import { SectionTile, tileIconOf, WidgetCard } from "@meetsanctum/ui-sdk";
import {
  ChevronRight,
  FileText,
  LayoutDashboard,
  LayoutGrid,
  Share2,
  SquarePlus,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Sentence } from "./automations/parts";
import type { Part } from "./automations/words";
import { Section } from "./components";

// What an app adds to the home, on its settings page: a driver's devices,
// its widgets and room section, each drawn by the shell from the manifest's
// samples as a slice of Home, on Home's background, its device pages, its
// workflow pieces as sentences with sample values, and the information it
// shares with other apps. Every count is the home's own, as the page opened;
// a part an app has nothing for is left out.

/** What the home has now, for the counts. */
export type HomeNow = {
  apps: readonly AppInfo[];
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  /** The app's own entities, its tiles and cards among them. */
  entities: readonly EntityInfo[];
  workflows: readonly WorkflowInfo[];
};

const counts = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
];

// "3 rooms", "1 automation".
function many(count: number, one: string, more = `${one}s`) {
  return `${count} ${count === 1 ? one : more}`;
}

// What people call devices of each kind, as the sidebar's categories do.
const kindNouns: Record<CapabilityKind, [string, string]> = {
  light: ["light", "lights"],
  switch: ["switch", "switches"],
  button: ["remote", "remotes"],
  sensor: ["sensor", "sensors"],
  occupancy: ["motion sensor", "motion sensors"],
};

function list(words: readonly string[]) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// "Weather's", and "Moods'" for a name that ends in s.
function possessive(name: string) {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function sizeWords(size: { columns: number; rows: number }) {
  const [columns, rows] = [counts[size.columns], counts[size.rows]];
  return size.columns === size.rows
    ? `${columns} cells square`
    : `${columns} cells wide, ${rows} high`;
}

function Line(props: { icon: LucideIcon; title: ReactNode; detail: string }) {
  const Icon = props.icon;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-sm font-medium">{props.title}</span>
        <span className="truncate text-[13px] font-medium text-muted-foreground">
          {props.detail}
        </span>
      </span>
    </div>
  );
}

// A slice of Home on its own background, which a screen reader hears as
// one picture of what it shows; nothing in it can be pressed.
function HomeSlice(props: {
  background: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="img"
      aria-label={props.label}
      className="home-slice rounded-md p-4"
      style={{ background: props.background }}
    >
      <div inert className="flex flex-col gap-3">
        {props.children}
      </div>
    </div>
  );
}

const grid =
  "grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)";

export function AppAdds(props: {
  app: AppInfo;
  manifest: StaticManifest;
  now: HomeNow;
  /** Home's background, which the previews stand on. */
  background: string;
}) {
  const { app, manifest, now } = props;
  const { provides } = manifest;
  const own = now.devices.filter((device) => device.driver === app.id);
  return (
    <>
      {manifest.driver && (
        <Section id="settings-app-devices" title="Devices it brings">
          <Line
            icon={SquarePlus}
            title={own.length === 0 ? "None yet" : many(own.length, "device")}
            detail={
              own.length === 0
                ? "Add them in Settings → Devices"
                : list(
                    capabilityKinds(own).map((kind) => kindNouns[kind][1]),
                  ).replace(/^./, (first) => first.toUpperCase())
            }
          />
        </Section>
      )}
      {provides.widgets.length > 0 && (
        <Section
          id="settings-app-widgets"
          title={provides.widgets.length === 1 ? "Widget" : "Widgets"}
          hint="Drawn from its sample"
        >
          {provides.widgets.map((widget) => {
            const shown = now.entities.some(
              (entity) => entity.type === widget.id,
            );
            return (
              <div key={widget.id} className="flex flex-col gap-3">
                <Line
                  icon={LayoutDashboard}
                  title={widget.title}
                  detail={`${shown ? "On Home, after the rooms" : `On Home once ${app.name} shows it`} · ${sizeWords(widget.size)}`}
                />
                <HomeSlice
                  background={props.background}
                  label={`A preview of the ${widget.title} card, with sample content`}
                >
                  <div className={grid}>
                    <WidgetCard
                      title={widget.title}
                      color={app.icon?.color ?? null}
                      size={widget.size}
                      content={widget.preview}
                    />
                  </div>
                </HomeSlice>
              </div>
            );
          })}
        </Section>
      )}
      {provides.roomSections.map((section) => {
        const placeIds = new Set(
          now.entities.flatMap((entity) =>
            entity.type === section.entityType &&
            typeof (entity.state as { placeId?: unknown })?.placeId === "string"
              ? [(entity.state as { placeId: string }).placeId]
              : [],
          ),
        );
        const rooms = now.rooms.filter((room) => placeIds.has(room.id));
        const room = rooms[0] ?? now.rooms[0];
        const tiles = section.preview ?? [];
        return (
          <Section
            key={section.id}
            id="settings-app-section"
            title="Room section"
            hint="Drawn from its samples"
          >
            <Line
              icon={LayoutGrid}
              title={section.title}
              detail={
                rooms.length === 0
                  ? "In no room yet"
                  : `In ${many(rooms.length, "room")}, under each room's name`
              }
            />
            {tiles.length > 0 && (
              <HomeSlice
                background={props.background}
                label={`A preview of ${possessive(app.name)} tiles under a room's name: ${list(
                  tiles.map((tile) =>
                    tile.active ? `${tile.name}, which is on` : tile.name,
                  ),
                )}`}
              >
                <span className="inline-flex items-center gap-0.5 text-[15px] leading-5 font-medium text-white">
                  {room?.name ?? "Living room"}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 text-white/65"
                  />
                </span>
                <div className={grid}>
                  {tiles.map((tile) => (
                    <SectionTile
                      key={tile.name}
                      icon={tileIconOf[tile.icon]}
                      name={tile.name}
                      active={tile.active}
                      onClick={() => undefined}
                    />
                  ))}
                </div>
              </HomeSlice>
            )}
          </Section>
        );
      })}
      {app.provides.devicePages.length > 0 && (
        <Section id="settings-app-device-pages" title="Device pages">
          {app.provides.devicePages.map((page) => {
            const kinds = new Set<string>(page.kinds);
            const devices = now.devices.filter((device) =>
              device.capabilities.some((each) => kinds.has(each.kind)),
            );
            // A kind this build has no words for is left out of the line.
            const known = page.kinds.filter((kind) =>
              Object.hasOwn(kindNouns, kind),
            );
            if (known.length === 0) return null;
            const nouns = known.map(
              (kind) => kindNouns[kind][devices.length === 1 ? 0 : 1],
            );
            return (
              <Line
                key={page.id}
                icon={FileText}
                title={page.title}
                detail={
                  devices.length === 0
                    ? `In the detail of ${list(known.map((kind) => kindNouns[kind][1]))}`
                    : `In the detail of your ${devices.length === 1 ? "" : `${devices.length} `}${list(nouns)}`
                }
              />
            );
          })}
        </Section>
      )}
      <PiecesSection app={app} manifest={manifest} now={now} />
      <SharesSection app={app} manifest={manifest} now={now} />
    </>
  );
}

// The kinds of devices among some, in the order the sidebar lists them.
function capabilityKinds(devices: readonly DeviceInfo[]): CapabilityKind[] {
  const kinds = new Set(
    devices.flatMap((device) => device.capabilities.map((each) => each.kind)),
  );
  return (Object.keys(kindNouns) as CapabilityKind[]).filter((kind) =>
    kinds.has(kind),
  );
}

// A sentence with its sample values in place of its {field} tokens.
function sampleParts(
  sentence: string,
  preview: Record<string, string> | undefined,
): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of sentence.matchAll(/\{(\w+)\}/g)) {
    if (match.index > at) parts.push(sentence.slice(at, match.index));
    const field = match[1]!;
    parts.push({ field, text: preview?.[field] ?? field, missing: false });
    at = match.index + match[0].length;
  }
  if (at < sentence.length) parts.push(sentence.slice(at));
  return parts;
}

// What a piece says: its sentence, or each of its presets', or its title.
function sentencesOf(words: PieceWords | null, title: string) {
  if (words?.sentence) return [words.sentence];
  const presets = (words?.presets ?? []).flatMap((preset) =>
    preset.sentence ? [preset.sentence] : [],
  );
  return presets.length > 0 ? presets : [title];
}

const pieceKindWords = {
  triggers: "Trigger",
  conditions: "Condition",
  steps: "Step",
} as const;

function PiecesSection(props: {
  app: AppInfo;
  manifest: StaticManifest;
  now: HomeNow;
}) {
  const { app, manifest, now } = props;
  const actionTitle = (id: string) =>
    manifest.actions.find((action) => action.id === id)?.title ?? id;
  const pieces = (["triggers", "conditions", "steps"] as const).flatMap(
    (kind) =>
      manifest.provides[kind].map((piece) => ({
        kind,
        id: piece.id,
        words: piece.words,
        title: "title" in piece ? piece.title : actionTitle(piece.id),
      })),
  );
  if (pieces.length === 0) return null;
  return (
    <Section
      id="settings-app-pieces"
      title="Workflow pieces"
      hint="With sample values"
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {pieces.map((piece) => {
          const used = now.workflows.filter((workflow) =>
            workflow.graph.nodes.some(
              (node) =>
                node.app === app.id &&
                node.piece === piece.id &&
                `${node.kind}s` === piece.kind,
            ),
          ).length;
          return (
            <li key={`${piece.kind}:${piece.id}`}>
              <Line
                icon={Workflow}
                title={sentencesOf(piece.words, piece.title).map(
                  (sentence, index) => (
                    <span key={index} className="block">
                      <Sentence
                        parts={sampleParts(sentence, piece.words?.preview)}
                        className="text-sm leading-tight"
                      />
                    </span>
                  ),
                )}
                detail={`${pieceKindWords[piece.kind]} · ${
                  used === 0
                    ? "Used by no automation yet"
                    : `Used by ${many(used, "automation")}`
                }`}
              />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function SharesSection(props: {
  app: AppInfo;
  manifest: StaticManifest;
  now: HomeNow;
}) {
  const { app, manifest, now } = props;
  const shared = manifest.provides.entities.filter((type) => type.standard);
  if (shared.length === 0) return null;
  return (
    <Section
      id="settings-app-shares"
      title="Information it shares"
      hint="Other apps read it with your permission"
    >
      {shared.map((type) => {
        const readers = now.apps.filter(
          (other) =>
            other.id !== app.id &&
            other.permissions.includes(entityReadPermission(type.id)),
        );
        return (
          <Line
            key={type.id}
            icon={Share2}
            title={type.title}
            detail={
              readers.length === 0
                ? "Read by no other app yet"
                : `Read by ${list(readers.map((reader) => reader.name))}`
            }
          />
        );
      })}
    </Section>
  );
}
