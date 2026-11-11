import { z } from "zod";

import type { EntityTypeDefinition } from "./entities.js";
import type { AppDefinition } from "./index.js";
import { tileIcons } from "./room-sections.js";

// Widgets: cards for dashboards that the shell draws with its own
// components, from content the app publishes. A card is a few blocks from a
// fixed list, with typed values the shell writes in the household's units,
// clock and language. The app works out what the card says, such as which
// day is today, and publishes it again when that changes; no app code runs
// to draw it.

/**
 * The icons a widget may show, as Lucide names them: a section tile's, and
 * the weather's. The shell draws each (ui-sdk's widgetIconOf), so a widget
 * shows only these.
 */
export const widgetIcons = [
  ...tileIcons,
  "cloud",
  "cloud-sun",
  "cloud-fog",
  "cloud-drizzle",
  "cloud-rain",
  "cloud-snow",
  "cloud-lightning",
  "cloud-hail",
] as const;
export type WidgetIcon = (typeof widgetIcons)[number];

/** The units a number on a card may have, which the shell writes as it does readings' (ui-sdk's units.ts). */
export const widgetUnits = ["lux"] as const;

/** At most this many blocks to a card, and this many characters to a text. */
export const widgetBlocksMax = 8;
export const widgetTextMaxLength = 120;

const singleLine = /^[^\r\n\u2028\u2029]*$/;

// The app's own words: one line, in sentence case.
const words = z
  .string()
  .trim()
  .min(1)
  .max(widgetTextMaxLength)
  .regex(singleLine, "use a single line");
// What a screen reader says for an icon, or the label of a button.
const label = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(singleLine, "use a single line");
const icon = z.enum(widgetIcons);

/**
 * A value on a card: the app's own words, or a typed value the shell
 * writes. A temperature is in degrees Celsius, shown in the household's
 * unit in whole degrees; a time is an instant, shown in the home's time
 * zone; a date is a day, shown as its short weekday ("Wed") or as a day
 * ("4 Nov"); a percent is whole.
 */
export const widgetValue = z.union([
  words,
  z.strictObject({ temperature: z.number() }),
  z.strictObject({ time: z.iso.datetime({ offset: true }) }),
  z.strictObject({
    date: z.iso.date(),
    as: z.enum(["weekday", "day"]).optional(),
  }),
  z.strictObject({ percent: z.number() }),
  z.strictObject({ number: z.number(), unit: z.enum(widgetUnits).optional() }),
]);
export type WidgetValue = z.infer<typeof widgetValue>;

// What a check or a button runs: one of the app's own actions, with its
// input, through the gate, as whoever pressed it.
const runs = {
  action: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
};

/** The blocks a card is made of, drawn in the order the app gives them. */
export const widgetBlock = z.discriminatedUnion("kind", [
  /** The main value, large and light, with an icon beside it. */
  z.strictObject({
    kind: z.literal("headline"),
    value: widgetValue,
    icon: icon.optional(),
    /** What a screen reader says for the icon; without it the icon is decoration. */
    iconLabel: label.optional(),
  }),
  /**
   * One line of detail, cut short if it is too long, naming its values as
   * {name}, the way workflow pieces' sentences do.
   */
  z.strictObject({
    kind: z.literal("line"),
    text: words,
    values: z.record(z.string().regex(/^\w+$/), widgetValue).optional(),
  }),
  /** Up to four small icons with a value each, on one line, such as sunrise and sunset. */
  z.strictObject({
    kind: z.literal("facts"),
    items: z
      .array(z.strictObject({ icon, label, value: widgetValue }))
      .min(1)
      .max(4),
  }),
  /** Up to seven equal columns at the card's foot, such as the next five days. */
  z.strictObject({
    kind: z.literal("columns"),
    items: z
      .array(
        z.strictObject({
          label: widgetValue,
          icon,
          iconLabel: label,
          value: widgetValue,
          detail: widgetValue.optional(),
        }),
      )
      .min(1)
      .max(7),
  }),
  /**
   * Up to six rows, each with its text, a detail under it and a value at
   * its end, and a check that runs one of the app's actions, such as a
   * list's items, ticked off from a dashboard.
   */
  z.strictObject({
    kind: z.literal("rows"),
    items: z
      .array(
        z.strictObject({
          text: widgetValue,
          detail: widgetValue.optional(),
          value: widgetValue.optional(),
          check: z.strictObject({ checked: z.boolean(), ...runs }).optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
  /** A sentence on its own, for a card with nothing to show yet. */
  z.strictObject({ kind: z.literal("note"), text: words }),
  /**
   * The card's one button, full width and last: it runs one of the app's
   * actions, with its input, or opens one of its pages.
   */
  z
    .strictObject({
      kind: z.literal("action"),
      label,
      icon: icon.optional(),
      action: runs.action.optional(),
      input: runs.input.optional(),
      page: z.string().min(1).max(64).optional(),
    })
    .refine(
      (block) =>
        block.page === undefined
          ? block.action !== undefined
          : block.action === undefined && block.input === undefined,
      "a button runs an action, with its input, or opens a page",
    ),
]);
export type WidgetBlock = z.infer<typeof widgetBlock>;

/** The {name} tokens of a line. */
function tokensOf(text: string) {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!));
}

/**
 * What a widget's card says: up to eight blocks, with at most one button,
 * last, and a value for every {name} a line names and for nothing else. The
 * core checks every card an app publishes against it, and `defineApp()` a
 * widget's preview.
 */
export const widgetContent = z
  .strictObject({
    blocks: z.array(widgetBlock).min(1).max(widgetBlocksMax),
  })
  .superRefine((card, context) => {
    const actions = card.blocks.filter((block) => block.kind === "action");
    if (
      actions.length > 1 ||
      (actions.length === 1 && card.blocks.at(-1)?.kind !== "action")
    ) {
      context.addIssue({
        code: "custom",
        message: "a card has one button at most, last",
        path: ["blocks"],
      });
    }
    card.blocks.forEach((block, index) => {
      if (block.kind !== "line") return;
      const tokens = tokensOf(block.text);
      const values = Object.keys(block.values ?? {});
      for (const token of tokens) {
        if (!values.includes(token)) {
          context.addIssue({
            code: "custom",
            message: `its line gives {${token}} no value`,
            path: ["blocks", index, "values"],
          });
        }
      }
      for (const name of values) {
        if (!tokens.has(name)) {
          context.addIssue({
            code: "custom",
            message: `its line gives ${name} a value, but does not name it`,
            path: ["blocks", index, "values"],
          });
        }
      }
    });
  });
export type WidgetContent = z.infer<typeof widgetContent>;

/** How much of a dashboard's grid a widget takes, in cells. */
export const widgetSize = z.strictObject({
  /** Widgets are four cells wide, on the tiles' columns. */
  columns: z.literal(4),
  rows: z.number().int().min(2).max(8),
});
export type WidgetSize = z.infer<typeof widgetSize>;

/**
 * A card for dashboards, which the shell draws from what the app shows
 * with ctx.widgets.show(). Its id is also the type of the entities that
 * hold its cards, one for each the app offers, by its own key.
 */
export interface WidgetDefinition {
  /** Namespaced, such as weather.card: part of the app's contract. */
  readonly id: string;
  /** Its title, in the app's colour. */
  readonly title: string;
  /** Its one size, such as four cells square. */
  readonly size: WidgetSize;
  /** Sample content, which its settings page shows before the app has published any. */
  readonly preview: WidgetContent;
}

export function defineWidget(widget: WidgetDefinition): WidgetDefinition {
  return widget;
}

/** A widget as clients see it (GET /api/apps). */
export type WidgetInfo = { id: string; title: string; size: WidgetSize };

export function widgetInfo(widget: WidgetDefinition): WidgetInfo {
  return { id: widget.id, title: widget.title, size: { ...widget.size } };
}

/**
 * The type of the entities that hold a widget's cards: the widget's id,
 * whose state is a card that runs and opens only what the app has, checked
 * whenever the app shows one and again when the app is installed.
 */
export function widgetEntityType(
  widget: WidgetDefinition,
  app: Pick<AppDefinition, "actions" | "pages">,
): EntityTypeDefinition<typeof widgetContent> {
  return {
    id: widget.id,
    title: widget.title,
    state: widgetContent.superRefine((card, context) => {
      for (const message of widgetContentProblems(app, card)) {
        context.addIssue({ code: "custom", message });
      }
    }),
  };
}

/**
 * What keeps a card the app shows from being its own: a check or a button
 * that runs an action it does not have, or one that is not read or write,
 * or with an input that action does not take, or a button that opens a
 * page it does not have.
 */
export function widgetContentProblems(
  app: Pick<AppDefinition, "actions" | "pages">,
  card: WidgetContent,
): string[] {
  // What a press runs, as the gate would take it: no input is {}.
  const runs = (what: string, id: string, input: unknown) => {
    const action = app.actions.find(
      (each) =>
        each.id === id && (each.tier === "read" || each.tier === "write"),
    );
    if (!action) {
      return [
        `its ${what} runs ${id}, which is not one of its read or write actions`,
      ];
    }
    return action.input.safeParse(input ?? {}).success
      ? []
      : [`its ${what} runs ${id} with an input it does not take`];
  };
  const pages = app.pages ?? [];
  return card.blocks.flatMap((block): string[] => {
    if (block.kind === "rows") {
      return block.items.flatMap((item) =>
        item.check ? runs("check", item.check.action, item.check.input) : [],
      );
    }
    if (block.kind !== "action") return [];
    if (block.page !== undefined) {
      return pages.includes(block.page)
        ? []
        : [`its button opens ${block.page}, which is not one of its pages`];
    }
    return block.action === undefined
      ? []
      : runs("button", block.action, block.input);
  });
}

const memberId = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/**
 * An app's widgets: each namespaced and titled, of one size, with a preview
 * that is one of its own cards, and an id that none of the entity types it
 * may publish has, since the id is its cards' type.
 */
export function assertWidgets(app: AppDefinition, typeIds: readonly string[]) {
  for (const widget of app.provides?.widgets ?? []) {
    const id = String(widget?.id);
    if (
      !memberId.test(id) ||
      typeof widget.title !== "string" ||
      !widget.title.trim()
    ) {
      throw new Error(
        `Widget "${id}" needs a namespaced id, such as weather.card, and a title`,
      );
    }
    if (typeIds.includes(id)) {
      throw new Error(
        `Widget "${id}" is the type of its cards, so no entity type may have its id`,
      );
    }
    if (!widgetSize.safeParse(widget.size).success) {
      throw new Error(
        `Widget "${id}" is four cells wide and 2 to 8 high, such as { columns: 4, rows: 4 }`,
      );
    }
    const preview = widgetContent.safeParse(widget.preview);
    if (!preview.success) {
      throw new Error(
        `Widget "${id}" previews a card: ${z.prettifyError(preview.error)}`,
      );
    }
    const problems = widgetContentProblems(app, preview.data);
    if (problems.length > 0) {
      throw new Error(
        `Widget "${id}" previews a card, but ${problems.join(", ")}`,
      );
    }
  }
}
