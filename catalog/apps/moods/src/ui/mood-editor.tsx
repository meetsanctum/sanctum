import {
  Button,
  DeviceSections,
  Input,
  type PageProps,
  tileIconOf,
} from "@meetsanctum/ui-sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { moodIcons, type MoodIcon } from "../moods/icons.js";
import { keyOf } from "../moods/light-states.js";
import { smartDefinition } from "../moods/smart.js";
import {
  changes,
  draftTile,
  fillDraft,
  moodLightsOf,
  roomLights,
  type Draft,
  type Mood,
} from "./mood-draft";
import {
  EditorFooter,
  EditorHeader,
  PreviewButton,
  useMoodEditing,
} from "./mood-editing";
import { MoodPicker } from "./mood-picker";
import { SmartMoodEditor } from "./smart-editor";
import { useMoodsApp } from "./state";

// The mood editor (v1's MoodEditorOverlay), a page a room's page opens on
// every device. A new mood starts with a choice: the room's lights as
// they are, or a smart mood from the catalog. A custom mood's editor has
// its name, its icon and what it sets each of the room's lights to, as
// tiles to tap and drag; a smart mood's is in smart-editor.tsx. Both
// preview the draft on the lights as it changes, with Cancel, which puts
// the lights back, and Save in the top bar (mood-editing.tsx): with no
// Back, they are the page's way out.

// The icons as a radio group: the arrow keys move the choice.
function IconPicker(props: {
  value: MoodIcon;
  onChange: (icon: MoodIcon) => void;
}) {
  const buttons = useRef(new Map<MoodIcon, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    const by =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : 0;
    if (by === 0) return;
    event.preventDefault();
    const at = moodIcons.indexOf(props.value);
    const next =
      moodIcons[(at + by + moodIcons.length) % moodIcons.length] ?? props.value;
    props.onChange(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Icon"
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-2"
    >
      {moodIcons.map((icon) => {
        const Icon = tileIconOf[icon];
        const chosen = icon === props.value;
        return (
          <Button
            variant="tile"
            size="icon-lg"
            key={icon}
            ref={(element) => {
              if (element) buttons.current.set(icon, element);
              else buttons.current.delete(icon);
            }}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={icon.replace(/-\d$/, "").replace("-", " ")}
            tabIndex={chosen ? 0 : -1}
            onClick={() => props.onChange(icon)}
          >
            <Icon aria-hidden="true" className="size-[18px]" />
          </Button>
        );
      })}
    </div>
  );
}

function MoodEditor(props: {
  room: { id: string; name: string };
  mood?: Mood;
  leave: () => void;
}) {
  const { room, mood, leave } = props;
  const { devices, moods } = useMoodsApp();
  const lights = useMemo(
    () => roomLights(devices, room.id),
    [devices, room.id],
  );
  const [name, setName] = useState(mood?.name ?? "");
  const [icon, setIcon] = useState<MoodIcon>(mood?.icon ?? "sparkles");
  const [started, setDraft] = useState<Draft>(() => new Map());
  const draft = useMemo(
    () => fillDraft(started, lights, mood),
    [started, lights, mood],
  );
  // Capture each light once, including lights arriving after the page loads.
  // Live reports must not rewrite an untouched draft.
  if (draft !== started) setDraft(draft);
  const moodLights = useMemo(
    () => moodLightsOf(draft, lights, mood),
    [draft, lights, mood],
  );
  const editing = useMoodEditing({
    roomId: room.id,
    lights,
    moodLights,
    mood,
    leave,
  });

  // A tap switches a light in the draft; a drag sets its level, and to
  // nothing switches it off, keeping the level it comes back on at.
  const update = (key: string, change: { on: boolean; brightness?: number }) =>
    setDraft((current) => {
      const next = new Map(fillDraft(current, lights, mood));
      const light = next.get(key);
      if (!light) return current;
      const { on, brightness } = change;
      next.set(key, {
        on,
        look:
          brightness === undefined ? light.look : { ...light.look, brightness },
      });
      return next;
    });

  const trimmed = name.trim();
  const canSave =
    trimmed.length > 0 &&
    moodLights.length > 0 &&
    changes(mood, { name, icon, lights: moodLights });

  const tiles = editing.withFailures(
    lights.map((light) => draftTile(light, draft.get(keyOf(light)))),
  );

  return (
    <>
      <EditorHeader
        title={mood ? mood.name : "New mood"}
        room={room.name}
        editing={editing}
        canSave={canSave}
        onSave={() =>
          void editing.save(() =>
            moods.save(
              { roomId: room.id, name: trimmed, icon, lights: moodLights },
              mood?.id,
            ),
          )
        }
      />
      <div className="flex max-w-xl flex-col gap-2">
        <label
          htmlFor="mood-name"
          className="text-[13px] leading-[18px] font-medium text-muted-foreground"
        >
          Name
        </label>
        <Input
          id="mood-name"
          value={name}
          maxLength={120}
          placeholder="Reading"
          onChange={(event) => setName(event.target.value)}
          className="h-10 bg-foreground/8 text-[15px] text-foreground placeholder:text-muted-foreground md:text-[15px]"
        />
      </div>
      <div className="flex max-w-xl flex-col gap-2">
        <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
          Icon
        </span>
        <IconPicker value={icon} onChange={setIcon} />
      </div>
      <div className="flex flex-col gap-3">
        <PreviewButton editing={editing} disabled={moodLights.length === 0} />
        <DeviceSections
          sections={[{ id: "mood-lights", title: "Lights", tiles }]}
          onToggle={(tile) => update(tile.key, { on: !tile.on })}
          onDim={(tile, brightness) =>
            update(
              tile.key,
              brightness > 0 ? { on: true, brightness } : { on: false },
            )
          }
        />
      </div>
      <EditorFooter editing={editing} mood={mood} />
    </>
  );
}

/**
 * The mood editor for a room: for a saved mood, or a new one once the
 * choice of kind is made. It leaves once, whether a button closed it or
 * what it edits went.
 */
export function MoodPage(props: PageProps) {
  const { places, moods } = useMoodsApp();
  const { back } = props;
  const { room: roomId, id } = props.params;
  const room = places?.rooms.find((each) => each.id === roomId);
  const mood = id ? moods.moods?.find((each) => each.id === id) : undefined;
  // A new mood's kind: "custom", or a smart mood's definition.
  const [kind, setKind] = useState<string | null>(null);
  const left = useRef(false);
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    back();
  }, [back]);
  const gone =
    (places !== undefined && !room) ||
    (id !== undefined && moods.moods !== undefined && !mood);
  useEffect(() => {
    if (gone) leave();
  }, [gone, leave]);
  if (gone || !room || (id !== undefined && !mood)) return null;

  if (mood?.smart) {
    return (
      <SmartMoodEditor
        key={mood.id}
        room={room}
        mood={mood}
        definition={smartDefinition(mood.smart.definition)}
        leave={leave}
      />
    );
  }
  if (mood || kind === "custom") {
    return (
      <MoodEditor key={id ?? "new"} room={room} mood={mood} leave={leave} />
    );
  }
  const definition = kind === null ? undefined : smartDefinition(kind);
  if (definition) {
    return (
      <SmartMoodEditor
        key={definition.id}
        room={room}
        definition={definition}
        leave={leave}
      />
    );
  }
  return <MoodPicker room={room} onChoose={setKind} onCancel={leave} />;
}
