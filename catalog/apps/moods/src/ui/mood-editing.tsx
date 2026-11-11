import { Button, PageBar, type Tile } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  lightKey,
  type MoodLight,
  type PreviewLight,
} from "../moods/light-states.js";
import type { Light } from "../targets.js";
import { restoreLights, type Mood } from "./mood-draft";
import { useMoodsApp } from "./state";

// What the custom and the smart mood editors share: the live preview,
// which shows the draft on the room's lights as it changes and puts back
// what they were when it is turned off, on Cancel or when the page goes;
// Save, which keeps the lights as they are; and Delete, asked twice.

// What the core answered, if it refused.

export function useMoodEditing(options: {
  roomId: string;
  /** The room's lights, as the editor shows them. */
  lights: readonly Light[];
  /** What the draft sets them to. */
  moodLights: MoodLight[];
  mood?: Mood;
  leave: () => void;
}) {
  const { roomId, lights, moodLights, mood, leave } = options;
  const { moods, schedules } = useMoodsApp();
  const { preview } = moods;
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [failures, setFailures] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  // What puts the lights back, from when the preview began until it ends.
  const restore = useRef<PreviewLight[] | null>(null);
  // One preview at a time, then the latest one asked for meanwhile.
  const sending = useRef<{
    next: PreviewLight[] | null;
    done?: Promise<void>;
  }>({
    next: null,
  });
  const send = useCallback(
    (sent: PreviewLight[]) => {
      const queue = sending.current;
      queue.next = sent;
      queue.done ??= (async () => {
        while (queue.next) {
          const next = queue.next;
          queue.next = null;
          try {
            const result = await preview(roomId, next);
            if (result.failed.length === 0) continue;
            setFailures((current) => {
              const counted = new Map(current);
              for (const each of result.failed) {
                const key = lightKey(each.device, each.capability);
                counted.set(key, (counted.get(key) ?? 0) + 1);
              }
              return counted;
            });
          } catch {
            setError("The lights could not show the mood.");
          }
        }
        queue.done = undefined;
      })();
      return queue.done;
    },
    [preview, roomId],
  );

  // The draft goes to the lights as it changes, while previewing, and a
  // light that turns up meanwhile is put back too.
  const signature = JSON.stringify(moodLights);
  const latest = useRef(moodLights);
  latest.current = moodLights;
  useEffect(() => {
    if (previewing && restore.current) {
      restore.current = restoreLights(lights, restore.current);
    }
  }, [previewing, lights]);
  useEffect(() => {
    if (previewing && latest.current.length > 0) void send(latest.current);
  }, [previewing, signature, send]);

  // Leaving the page any other way puts the lights back too, after any
  // preview still on its way.
  useEffect(
    () => () => {
      if (restore.current?.length) void send(restore.current);
    },
    [send],
  );

  const putBack = async () => {
    const saved = restore.current;
    restore.current = null;
    if (saved?.length) await send(saved);
  };

  const togglePreview = async () => {
    setError(undefined);
    if (previewing) {
      setPreviewing(false);
      setBusy(true);
      await putBack();
      setBusy(false);
      return;
    }
    restore.current = restoreLights(lights, restore.current ?? []);
    setPreviewing(true);
  };

  /** Saves through `write`, keeping the lights as the preview left them. */
  const save = async (write: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await write();
      restore.current = null;
      leave();
    } catch {
      setError("The mood could not be saved.");
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setPreviewing(false);
    await putBack();
    leave();
  };

  const remove = async () => {
    if (!mood) return;
    setBusy(true);
    setError(undefined);
    try {
      // The lights first, while the page is still there.
      setPreviewing(false);
      await putBack();
      await moods.remove(mood.id);
      // It is off its room's schedule now.
      void schedules.load().catch(() => undefined);
      leave();
    } catch (failure) {
      setError("The mood could not be deleted.");
      setConfirming(false);
      setBusy(false);
    }
  };

  /** The tiles, each showing a preview command that failed for it. */
  const withFailures = (tiles: Tile[]) =>
    tiles.map((tile) => {
      const failed = failures.get(tile.key);
      return failed ? { ...tile, failures: failed } : tile;
    });

  return {
    previewing,
    busy,
    confirming,
    setConfirming,
    error,
    togglePreview,
    save,
    cancel,
    remove,
    withFailures,
  };
}

export type MoodEditing = ReturnType<typeof useMoodEditing>;

/**
 * An editor's title in the top bar with its Cancel and Save, which stay in
 * view while it scrolls, and its room at the top of the page.
 */
export function EditorHeader(
  props: { title: string; room: string } & (
    | { editing: MoodEditing; canSave: boolean; onSave: () => void }
    | { onCancel: () => void }
  ),
) {
  return (
    <>
      <PageBar title={props.title}>
        {"editing" in props ? (
          <>
            <CancelButton
              onClick={() => void props.editing.cancel()}
              disabled={props.editing.busy}
            />
            <Button
              onClick={props.onSave}
              disabled={props.editing.busy || !props.canSave}
            >
              Save
            </Button>
          </>
        ) : (
          <CancelButton onClick={props.onCancel} />
        )}
      </PageBar>
      <p className="m-0 shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        {props.room}
      </p>
    </>
  );
}

export function PreviewButton(props: {
  editing: MoodEditing;
  disabled?: boolean;
}) {
  const { editing } = props;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="tile"
        size="chip"
        aria-pressed={editing.previewing}
        onClick={() => void editing.togglePreview()}
        disabled={editing.busy || props.disabled}
      >
        Preview on the lights
      </Button>
    </div>
  );
}

/**
 * The editors' way out, which keeps nothing and leaves.
 */
export function CancelButton(props: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="outline" onClick={props.onClick} disabled={props.disabled}>
      Cancel
    </Button>
  );
}

/**
 * What went wrong, and for a saved mood Delete, at the foot of the editor;
 * Cancel, which puts the lights back, and Save, which keeps them, are in
 * the top bar (EditorHeader).
 */
export function EditorFooter(props: { editing: MoodEditing; mood?: Mood }) {
  const { editing, mood } = props;
  const { busy } = editing;
  const { schedules } = useMoodsApp();
  const scheduled =
    mood !== undefined &&
    (schedules.of(mood.roomId)?.scheduled ?? []).some(
      (each) => each.moodId === mood.id,
    );
  return (
    <>
      {editing.error && (
        <p role="alert" className="m-0 text-[13px] font-medium text-(--danger)">
          {editing.error}
        </p>
      )}
      {mood && (
        <div className="flex flex-wrap items-center gap-2">
          {editing.confirming ? (
            <>
              <span className="text-[13px] font-medium text-muted-foreground">
                {scheduled
                  ? `Delete ${mood.name}? It comes off the schedule too.`
                  : `Delete ${mood.name}?`}
              </span>
              <Button
                variant="destructive"
                onClick={() => void editing.remove()}
                disabled={busy}
              >
                Delete
              </Button>
              <Button
                variant="ghost"
                onClick={() => editing.setConfirming(false)}
                disabled={busy}
              >
                Keep it
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              onClick={() => editing.setConfirming(true)}
              disabled={busy}
              className="-ms-2.5"
            >
              Delete mood
            </Button>
          )}
        </div>
      )}
    </>
  );
}
