import {
  widgetContent,
  type AppInfo,
  type EntityInfo,
  type WidgetContent,
  type WidgetInfo,
} from "@meetsanctum/app-sdk";
import { WidgetCard, type LiveFeed } from "@meetsanctum/ui-sdk";

import { entityKey, shownType, useAppEntities } from "./app-entities";
import { isShown, stateShort } from "./app-state";
import { coreJson } from "./core-fetch";

// Apps' widgets on Home: the shell draws each card from what its app shows,
// after the rooms, in the order of the apps and then of their widgets. No
// app code runs to draw one. A row's check or a card's button runs the app's
// action through the gate; while the app isn't running its cards say so and
// can't be pressed.

/** One of an app's cards, as its entity says. */
export type ShownCard = {
  app: string;
  widget: string;
  key: string;
  content: WidgetContent;
};

function shownCard(entity: EntityInfo): ShownCard | null {
  const content = widgetContent.safeParse(entity.state);
  return content.success
    ? {
        app: entity.app,
        widget: entity.type,
        key: entity.key,
        content: content.data,
      }
    : null;
}

/** Every installed app's cards, read and followed as room sections' tiles are. */
export function useWidgetCards(live: LiveFeed, apps: readonly AppInfo[]) {
  return useAppEntities(
    live,
    apps.flatMap((app) =>
      app.provides.widgets.map((widget) => shownType(app.id, widget.id)),
    ),
    shownCard,
  );
}

export function HomeWidgets(props: {
  apps: readonly AppInfo[];
  cards: ReadonlyMap<string, ShownCard>;
  /** Opens one of an app's pages, for a button that opens one. */
  open: (app: string, page: string) => void;
}) {
  const shown = props.apps.filter(isShown).flatMap((app) =>
    app.provides.widgets.flatMap((widget: WidgetInfo) =>
      [...props.cards.values()]
        .filter((card) => card.app === app.id && card.widget === widget.id)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((card) => ({ app, widget, card })),
    ),
  );
  if (shown.length === 0) return null;
  return (
    <div className="grid shrink-0 auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)">
      {shown.map(({ app, widget, card }) => (
        <WidgetCard
          key={entityKey(card.app, card.key)}
          title={widget.title}
          color={app.icon?.color ?? null}
          size={widget.size}
          content={card.content}
          unavailable={stateShort(app) ?? undefined}
          run={(action, input) =>
            coreJson<unknown>(
              `/api/apps/${encodeURIComponent(app.id)}/actions/${encodeURIComponent(action)}`,
              { method: "POST", json: input },
            )
          }
          open={(page) => props.open(app.id, page)}
        />
      ))}
    </div>
  );
}
