import {
  capabilities,
  capabilityKinds,
  type AppInfo,
  type DeviceInfo,
  type PieceInfo,
  type PiecePreset,
  type PieceKind,
  type WorkflowNode,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { Search } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import type { Home } from "./fields";
import { PieceIcon } from "./parts";
import {
  compareGroups,
  fieldKind,
  fieldsOf,
  plain,
  sentenceParts,
  type Names,
} from "./words";

// Add a trigger, a condition or a step: what it's about first, a room's
// devices like the sidebar lists them, then the apps' pieces and the core's
// own by their groups. Each entry is a piece or one of its presets, with
// what it names filled in where the entry says; the rest is filled in on its
// card.

export type NewNode = Omit<WorkflowNode, "id">;

type Entry = {
  key: string;
  title: string;
  sub?: string;
  icon: ReactNode;
  node: NewNode;
};
type Section = { id: string; title: string; entries: Entry[] };

const titles: Record<PieceKind, { title: string; description: string }> = {
  trigger: {
    title: "Add a trigger",
    description: "What starts it? Pick one; you fill in the rest on its card.",
  },
  condition: {
    title: "Add a condition",
    description: "It runs only while this is true.",
  },
  step: { title: "Add a step", description: "What should it do?" },
};

/** The field that names a device, and the one naming its part, if any. */
function deviceFields(piece: PieceInfo) {
  const fields = Object.entries(fieldsOf(piece.config));
  const device = fields.find(
    ([, field]) =>
      fieldKind(field).kind === "names" && field.names === "device",
  )?.[0];
  const part = fields.find(([, field]) => field.partOf === device)?.[0];
  const place = fields.find(([, field]) => field.place === true)?.[0];
  return { device, part, place };
}

// The kinds whose state has a field, such as a motion sensor's occupied.
function kindsWith(field: string): string[] {
  return capabilityKinds.filter((kind) => {
    const { shape } = capabilities[kind].state as { shape?: object };
    return shape !== undefined && Object.hasOwn(shape, field);
  });
}

/**
 * The kinds of device a piece's device field fits: the kind its config
 * names, else those whose state has the field a core piece compares, such
 * as occupied for "{device} sees motion", else lights and switches.
 */
export function deviceKindsFor(
  piece: PieceInfo,
  config: Record<string, unknown> = {},
) {
  if (typeof config.kind === "string") return [config.kind];
  if (piece.group === "Buttons") return ["button"];
  if (!piece.app && typeof config.field === "string") {
    const kinds = kindsWith(config.field);
    if (kinds.length > 0) return kinds;
  }
  return piece.app ? ["light"] : ["light", "switch"];
}

/**
 * The presses a device's buttons know, for a piece with an action field
 * beside its device, as a remote's press trigger has.
 */
function pressesOf(
  piece: PieceInfo,
  device: DeviceInfo,
  kinds: readonly string[],
): { capability: string; action: string }[] {
  const field = fieldsOf(piece.config).action;
  if (!field || field.names || field.partOf) return [];
  return device.capabilities.flatMap((capability) => {
    const features = capability.features as { actions?: unknown } | undefined;
    return kinds.includes(capability.kind) && Array.isArray(features?.actions)
      ? (features.actions as string[]).map((action) => ({
          capability: capability.id,
          action,
        }))
      : [];
  });
}

/** A new node's config with its device, and the part of it that fits. */
export function withDevice(
  piece: PieceInfo,
  config: Record<string, unknown>,
  device: DeviceInfo,
) {
  const { device: field, part } = deviceFields(piece);
  if (!field) return config;
  const kinds = deviceKindsFor(piece, config);
  const capability = device.capabilities.find((each) =>
    kinds.includes(each.kind),
  );
  return {
    ...config,
    [field]: device.id,
    ...(part && capability && { [part]: capability.id }),
  };
}

function sectionsFor(
  kind: PieceKind,
  pieces: readonly PieceInfo[],
  home: Home,
  apps: readonly AppInfo[],
  names: Names,
): Section[] {
  const ofKind = pieces.filter((piece) => piece.kind === kind);
  const icon = (piece: PieceInfo, config: Record<string, unknown>) => (
    <PieceIcon piece={piece} node={{ config }} apps={apps} names={names} />
  );
  const read = (
    piece: PieceInfo,
    preset: PiecePreset | undefined,
    config: Record<string, unknown>,
  ) => {
    const template = preset?.sentence ?? piece.sentence;
    return template
      ? plain(sentenceParts(template, piece, config, names))
      : (preset?.title ?? piece.title);
  };
  const variants = (piece: PieceInfo) =>
    piece.presets.length > 0 ? piece.presets : [undefined];
  const node = (
    piece: PieceInfo,
    config: Record<string, unknown>,
  ): NewNode => ({
    kind,
    ...(piece.app && { app: piece.app }),
    piece: piece.id,
    config,
  });

  // A room's devices and lights, in the sidebar's order.
  const rooms = [...(home.places?.rooms ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const roomSections: Section[] = rooms.map((room) => {
    const entries: Entry[] = [];
    for (const piece of ofKind) {
      const { device: deviceField, place } = deviceFields(piece);
      for (const preset of variants(piece)) {
        const base = { ...(preset?.config ?? {}) };
        if (deviceField) {
          const kinds = deviceKindsFor(piece, base);
          for (const device of home.devices.filter(
            (each) =>
              each.roomId === room.id &&
              each.capabilities.some((capability) =>
                kinds.includes(capability.kind),
              ),
          )) {
            const config = withDevice(piece, base, device);
            // A remote's press: one entry for each press its buttons know,
            // such as Single press on Office button.
            // Each press names the button it's on, for a remote with more
            // than one.
            const { part } = deviceFields(piece);
            const presses = pressesOf(piece, device, kinds);
            for (const press of presses.length > 0 ? presses : [undefined]) {
              const each =
                press === undefined
                  ? config
                  : {
                      ...config,
                      ...(part && { [part]: press.capability }),
                      action: press.action,
                    };
              entries.push({
                key: `${piece.app}:${piece.id}:${preset?.title}:${device.id}:${press ? `${press.capability}:${press.action}` : ""}`,
                title: read(piece, preset, each),
                icon: icon(piece, each),
                node: node(piece, each),
              });
            }
          }
        } else if (place) {
          const config = { ...base, [place]: { kind: "room", id: room.id } };
          entries.push({
            key: `${piece.app}:${piece.id}:${preset?.title}:${room.id}`,
            title: read(piece, preset, config),
            icon: icon(piece, config),
            node: node(piece, config),
          });
        }
      }
    }
    return { id: `room-${room.id}`, title: room.name, entries };
  });

  // Each piece by its group or its app, filled in on its card. A core
  // piece about a device shows once, by its title; its presets are under
  // the rooms.
  const grouped = new Map<string, Entry[]>();
  for (const piece of ofKind) {
    const group =
      piece.group ??
      (piece.app
        ? (apps.find((app) => app.id === piece.app)?.name ?? piece.app)
        : "More");
    const { device } = deviceFields(piece);
    const list = device && !piece.app ? [undefined] : variants(piece);
    for (const preset of list) {
      const config = { ...(preset?.config ?? {}) };
      grouped.set(group, [
        ...(grouped.get(group) ?? []),
        {
          key: `${piece.app}:${piece.id}:${preset?.title}`,
          title: preset?.title ?? piece.title,
          ...(preset && piece.presets.length > 1 && { sub: piece.title }),
          icon: icon(piece, config),
          node: node(piece, config),
        },
      ]);
    }
  }
  const groups = [...grouped]
    .sort(([a], [b]) =>
      a === "More" ? 1 : b === "More" ? -1 : compareGroups(a, b),
    )
    .map(([title, entries]) => ({ id: `group-${title}`, title, entries }));
  // A trigger is mostly about a time or the sun; a step about a room.
  const first =
    kind === "trigger"
      ? groups.filter((group) =>
          ["Time", "Sunrise and sunset", "By hand"].includes(group.title),
        )
      : [];
  const rest = groups.filter((group) => !first.includes(group));
  return [...first, ...roomSections, ...rest].filter(
    (section) => section.entries.length > 0,
  );
}

export function Chooser(props: {
  kind: PieceKind | null;
  pieces: readonly PieceInfo[];
  home: Home;
  apps: readonly AppInfo[];
  names: Names;
  onPick(node: NewNode): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  // Kept while the dialog closes.
  const shown = useRef(props.kind ?? "trigger");
  if (props.kind) shown.current = props.kind;
  const kind = shown.current;
  const sections = useMemo(
    () => sectionsFor(kind, props.pieces, props.home, props.apps, props.names),
    [kind, props.pieces, props.home, props.apps, props.names],
  );
  const words = query.trim().toLocaleLowerCase();
  const found = sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter(
        (entry) =>
          !words ||
          `${section.title} ${entry.title} ${entry.sub ?? ""}`
            .toLocaleLowerCase()
            .includes(words),
      ),
    }))
    .filter((section) => section.entries.length > 0);
  const list = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open={props.kind !== null}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
          setQuery("");
        }
      }}
    >
      <DialogContent
        // Cancel is its way out; a bare × beside a search can't say whether it keeps anything.
        showCloseButton={false}
        className="flex max-h-[min(680px,calc(100dvh-2rem))] flex-col gap-3.5 sm:max-w-132"
      >
        <DialogHeader>
          <DialogTitle className="text-xl leading-7 font-normal">
            {titles[kind].title}
          </DialogTitle>
          <DialogDescription>{titles[kind].description}</DialogDescription>
        </DialogHeader>
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-[15px]">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${titles[kind].title.replace("Add a ", "")}s`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        {!words && sections.length > 1 && (
          <div className="flex shrink-0 flex-wrap gap-1.5">
            {sections.map((section) => (
              <Button
                variant="outline"
                size="sm"
                key={section.id}
                type="button"
                onClick={() =>
                  list.current
                    ?.querySelector(`[data-section="${section.id}"]`)
                    ?.scrollIntoView({ block: "start" })
                }
              >
                {section.title}
              </Button>
            ))}
          </div>
        )}
        <div
          ref={list}
          className="-mx-6 flex min-h-0 flex-1 flex-col gap-4.5 overflow-y-auto px-6"
        >
          {found.length === 0 && (
            <p className="m-0 text-[15px] text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          )}
          {found.map((section) => (
            <section
              key={section.id}
              data-section={section.id}
              aria-label={section.title}
              className="flex flex-col gap-0.5"
            >
              <h3 className="m-0 mb-1 text-[13px] leading-[18px] font-medium text-muted-foreground">
                {section.title}
              </h3>
              {section.entries.map((entry) => (
                <Button
                  variant="row"
                  size="row"
                  key={entry.key}
                  type="button"
                  onClick={() => {
                    props.onPick(entry.node);
                    setQuery("");
                  }}
                  className="-mx-2.5 w-[calc(100%+20px)]"
                >
                  {entry.icon}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] leading-5">
                      {entry.title}
                    </span>
                    {entry.sub && (
                      <span className="truncate text-[13px] leading-[18px] text-muted-foreground">
                        {entry.sub}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              props.onClose();
              setQuery("");
            }}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
