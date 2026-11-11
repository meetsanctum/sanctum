import type { EntityInfo, LiveMessage } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import { coreJson } from "./core-fetch";

// Installed apps' entities that the shell draws itself, such as room
// sections' tiles and widgets' cards: each app's of the types it names, read
// whenever the shell refreshes its live feed and when those change, and
// followed over it in between; what changed meanwhile is replayed over a
// slower read.

/** An entity's key among every app's, as "app/key". */
export const entityKey = (app: string, key: string) => `${app}/${key}`;

/** One app's entities of one type, as "app type". */
export const shownType = (app: string, type: string) => `${app} ${type}`;

/**
 * The entities of the types shown, each as `parse` makes it, by entityKey;
 * one it cannot make is left out. `parse` is read when an entity arrives,
 * so it need not be stable.
 */
export function useAppEntities<T>(
  live: LiveFeed,
  shown: readonly string[],
  parse: (entity: EntityInfo) => T | null,
): ReadonlyMap<string, T> {
  const [entities, setEntities] = useState<ReadonlyMap<string, T>>(
    () => new Map(),
  );
  const parseRef = useRef(parse);
  // Before the effect below, which reads it.
  useEffect(() => {
    parseRef.current = parse;
  });
  const signature = [...new Set(shown)].sort().join();

  type Update = (current: ReadonlyMap<string, T>) => ReadonlyMap<string, T>;
  const pendingLoad = useRef<{ updates: Update[] } | null>(null);

  useEffect(() => {
    const pairs = signature
      ? signature.split(",").map((pair) => pair.split(" ") as [string, string])
      : [];
    const wanted = new Set(signature ? signature.split(",") : []);
    const parsed = (entity: EntityInfo) =>
      wanted.has(shownType(entity.app, entity.type))
        ? parseRef.current(entity)
        : null;
    let isStopped = false;
    const update = (change: Update) => {
      pendingLoad.current?.updates.push(change);
      setEntities(change);
    };
    const load = async () => {
      const request = { updates: [] as Update[] };
      pendingLoad.current = request;
      try {
        const lists = await Promise.all(
          pairs.map(([app, type]) =>
            coreJson<EntityInfo[]>(
              `/api/entities?app=${encodeURIComponent(app)}&type=${encodeURIComponent(type)}`,
            ),
          ),
        );
        if (isStopped || pendingLoad.current !== request) return;
        const loaded = new Map<string, T>();
        for (const entity of lists.flat()) {
          const each = parsed(entity);
          if (each !== null)
            loaded.set(entityKey(entity.app, entity.key), each);
        }
        setEntities(
          request.updates.reduce<ReadonlyMap<string, T>>(
            (current, change) => change(current),
            loaded,
          ),
        );
      } finally {
        if (pendingLoad.current === request) pendingLoad.current = null;
      }
    };
    const read = () => {
      if (pairs.length === 0) {
        setEntities(new Map());
        return;
      }
      void load().catch(() => undefined);
    };
    // The apps are known once the host has answered, so their entities can
    // be read at once.
    read();
    const stop = live.subscribe({
      refresh: read,
      message(message: LiveMessage) {
        if (message.type !== "entity") return;
        const key = entityKey(message.app, message.key);
        const next = message.entity && parsed(message.entity);
        update((current) => {
          if (!next && !current.has(key)) return current;
          const changed = new Map(current);
          if (next) changed.set(key, next);
          else changed.delete(key);
          return changed;
        });
      },
    });
    return () => {
      isStopped = true;
      pendingLoad.current = null;
      stop();
    };
  }, [live, signature]);

  return entities;
}
