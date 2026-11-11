import { useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useRef, useState } from "react";

import type {
  createMood,
  deleteMood,
  listMoods,
  orderMoods,
  previewMood,
  updateMood,
} from "../moods/actions.js";
import type {
  assignSmartMood,
  updateSmartMood,
} from "../moods/smart-actions.js";
import type { SmartSettings } from "../moods/smart.js";
import type { MoodIcon } from "../moods/icons.js";
import type { MoodLight, PreviewLight } from "../moods/light-states.js";
import type { Mood } from "./mood-draft";

// The household's moods, through Moods' actions, which workflows run too.
// The moods are read again whenever the shell refreshes; the core does not
// push another client's changes. Running one is the shell's, from a room's
// page.

export type MoodDraft = {
  roomId: string;
  name: string;
  icon: MoodIcon;
  lights: MoodLight[];
};

/** The moods, with what changes them. */
export function useMoods() {
  const client = useAppClient();
  const [moods, setMoods] = useState<Mood[]>();
  type MoodUpdate = (current: Mood[] | undefined) => Mood[] | undefined;
  const pendingLoad = useRef<{ updates: MoodUpdate[] } | null>(null);

  // As with device snapshots, replay local changes over an older response.
  // This also keeps the rest of the list when a write beats the initial load.
  const updateMoods = useCallback((update: MoodUpdate) => {
    pendingLoad.current?.updates.push(update);
    setMoods(update);
  }, []);

  const load = useCallback(async () => {
    const request = { updates: [] as MoodUpdate[] };
    pendingLoad.current = request;
    try {
      const loaded = await client.call<typeof listMoods>("moods.moods", {});
      if (pendingLoad.current !== request) return;
      setMoods(
        request.updates.reduce<Mood[] | undefined>(
          (current, update) => update(current),
          loaded,
        ),
      );
    } finally {
      if (pendingLoad.current === request) pendingLoad.current = null;
    }
  }, [client]);

  // Shows the new order at once, and the core's once it answers.
  const order = useCallback(
    async (roomId: string, moodIds: string[]) => {
      updateMoods((current) => {
        if (!current) return current;
        const rank = new Map(moodIds.map((id, index) => [id, index]));
        const rest = current.filter((mood) => mood.roomId !== roomId);
        const room = current
          .filter((mood) => mood.roomId === roomId)
          .sort(
            (a, b) =>
              (rank.get(a.id) ?? moodIds.length) -
              (rank.get(b.id) ?? moodIds.length),
          );
        return [...rest, ...room];
      });
      try {
        await client.call<typeof orderMoods>("moods.orderMoods", {
          roomId,
          moodIds,
        });
      } finally {
        await load().catch(() => undefined);
      }
    },
    [client, load, updateMoods],
  );

  const save = useCallback(
    async (draft: MoodDraft, id?: string) => {
      const saved = id
        ? await client.call<typeof updateMood>("moods.updateMood", {
            id,
            name: draft.name,
            icon: draft.icon,
            lights: draft.lights,
          })
        : await client.call<typeof createMood>("moods.createMood", draft);
      updateMoods((current) =>
        current?.some((mood) => mood.id === saved.id)
          ? current.map((mood) => (mood.id === saved.id ? saved : mood))
          : [...(current ?? []), saved],
      );
      return saved;
    },
    [client, updateMoods],
  );

  // A smart mood: assigned to the room, or its settings changed.
  const saveSmart = useCallback(
    async (
      settings: SmartSettings,
      to: { roomId: string; definitionId: string } | { id: string },
    ) => {
      const saved =
        "id" in to
          ? await client.call<typeof updateSmartMood>("moods.updateSmartMood", {
              id: to.id,
              ...settings,
            })
          : await client.call<typeof assignSmartMood>("moods.assignSmartMood", {
              ...to,
              ...settings,
            });
      updateMoods((current) =>
        current?.some((mood) => mood.id === saved.id)
          ? current.map((mood) => (mood.id === saved.id ? saved : mood))
          : [...(current ?? []), saved],
      );
      return saved;
    },
    [client, updateMoods],
  );

  const remove = useCallback(
    async (id: string) => {
      await client.call<typeof deleteMood>("moods.deleteMood", { id });
      updateMoods((current) => current?.filter((mood) => mood.id !== id));
    },
    [client, updateMoods],
  );

  const preview = useCallback(
    (roomId: string, lights: PreviewLight[]) =>
      client.call<typeof previewMood>("moods.previewMood", { roomId, lights }),
    [client],
  );

  return { moods, load, order, save, saveSmart, remove, preview };
}

export type Moods = ReturnType<typeof useMoods>;
