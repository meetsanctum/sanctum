import { DeviceSections, Slider } from "@meetsanctum/ui-sdk";
import { useMemo, useState } from "react";

import { keyOf, lightKey } from "../moods/light-states.js";
import {
  smartLights,
  type SmartDefinition,
  type SmartSettings,
} from "../moods/smart.js";
import { draftOf, draftTile, roomLights, type Mood } from "./mood-draft";
import {
  EditorFooter,
  EditorHeader,
  PreviewButton,
  useMoodEditing,
} from "./mood-editing";
import { useMoodsApp } from "./state";

// A smart mood's editor: its name, icon and colours are the catalog's, so
// it sets a brightness for the room's lights and which of them it leaves
// off. The tiles show what each light will be, its colour by name in turn;
// tapping one leaves it off or brings it back. It previews like the custom
// editor.

// Whether the settings differ from the saved mood's.
function changed(mood: Mood | undefined, settings: SmartSettings) {
  if (!mood?.smart) return true;
  const keys = (list: SmartSettings["off"]) =>
    list
      .map((each) => lightKey(each.device, each.capability))
      .sort()
      .join();
  return (
    mood.smart.brightness !== settings.brightness ||
    keys(mood.smart.off) !== keys(settings.off)
  );
}

export function SmartMoodEditor(props: {
  room: { id: string; name: string };
  /** The catalog's definition; none when it no longer has the mood's. */
  definition: SmartDefinition | undefined;
  mood?: Mood;
  leave: () => void;
}) {
  const { room, definition, mood, leave } = props;
  const { devices, moods } = useMoodsApp();
  const lights = useMemo(
    () => roomLights(devices, room.id),
    [devices, room.id],
  );
  const online = useMemo(
    () => lights.filter((light) => light.device.availability !== "offline"),
    [lights],
  );
  const [brightness, setBrightness] = useState(
    mood?.smart?.brightness ?? definition?.brightness ?? 100,
  );
  // The level the slider shows while it moves; the draft takes it once it
  // stops, so the preview does not chase every step.
  const [sliding, setSliding] = useState<number | null>(null);
  const [off, setOff] = useState<SmartSettings["off"]>(mood?.smart?.off ?? []);
  const settings = useMemo(() => ({ brightness, off }), [brightness, off]);
  const moodLights = useMemo(
    () => (definition ? smartLights(definition, settings, online) : []),
    [definition, settings, online],
  );
  const editing = useMoodEditing({
    roomId: room.id,
    lights,
    moodLights,
    mood,
    leave,
  });

  const states = new Map(
    moodLights.map((each) => [
      lightKey(each.device, each.capability),
      each.state,
    ]),
  );
  const tiles = editing.withFailures(
    lights.map((light) => {
      const state = states.get(keyOf(light));
      // Its level is the mood's, so a tile only switches.
      return {
        ...draftTile(light, state && draftOf(state)),
        dims: false,
      };
    }),
  );

  // Leaves a light off, or brings it back.
  const toggle = (device: string, capability: string) =>
    setOff((current) => {
      const key = lightKey(device, capability);
      const kept = current.filter(
        (each) => lightKey(each.device, each.capability) !== key,
      );
      return kept.length < current.length
        ? kept
        : [...current, { device, capability }];
    });

  const shown = sliding ?? brightness;
  return (
    <>
      <EditorHeader
        title={mood?.name ?? definition?.name ?? ""}
        room={room.name}

        editing={editing}
        canSave={definition !== undefined && changed(mood, settings)}
        onSave={() =>
          void editing.save(() =>
            moods.saveSmart(
              settings,
              mood
                ? { id: mood.id }
                : { roomId: room.id, definitionId: definition!.id },
            ),
          )
        }
      />
      <div className="flex max-w-xl flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span
            id="smart-brightness"
            className="text-[13px] leading-[18px] font-medium text-muted-foreground"
          >
            Brightness
          </span>
          <span className="text-[13px] leading-[18px] font-medium tabular-nums">
            {shown}%
          </span>
        </div>
        <Slider
          aria-labelledby="smart-brightness"
          min={1}
          max={100}
          step={1}
          value={[shown]}
          disabled={!definition}
          onValueChange={([value]) => setSliding(value ?? brightness)}
          onValueCommit={([value]) => {
            setSliding(null);
            if (value !== undefined) setBrightness(value);
          }}
        />
      </div>
      <div className="flex flex-col gap-3">
        <PreviewButton editing={editing} disabled={moodLights.length === 0} />
        <DeviceSections
          sections={[{ id: "mood-lights", title: "Lights", tiles }]}
          onToggle={(tile) => toggle(tile.deviceId, tile.capabilityId)}
          onDim={() => {}}
        />
      </div>
      <EditorFooter editing={editing} mood={mood} />
    </>
  );
}
