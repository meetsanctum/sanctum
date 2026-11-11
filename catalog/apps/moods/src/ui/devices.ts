import type { DeviceInfo, LiveMessage, Places } from "@meetsanctum/app-sdk";
import { useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useRef, useState } from "react";

// The devices and places Moods' pages read, for the moods of a room and the
// mood editor: read again whenever the live connection comes back or the
// shell refreshes, and followed through the live updates in between.
// Switching them is the shell's and the core's; the editor previews through
// Moods' actions.

/** The devices and places Moods may see, kept current. */
export function useDevices() {
  const client = useAppClient();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [places, setPlaces] = useState<Places>();

  type DeviceUpdate = (current: DeviceInfo[]) => DeviceInfo[];
  const pendingLoad = useRef<{
    updates: DeviceUpdate[];
    places?: Places;
  } | null>(null);

  // Replay changes received during a snapshot request over that snapshot.
  // Otherwise a slow HTTP response can undo a live update or a removal.
  const updateDevices = useCallback((update: DeviceUpdate) => {
    pendingLoad.current?.updates.push(update);
    setDevices(update);
  }, []);

  const load = useCallback(async () => {
    const request = {
      updates: [] as DeviceUpdate[],
      places: undefined as Places | undefined,
    };
    pendingLoad.current = request;
    try {
      const [nextDevices, nextPlaces] = await Promise.all([
        client.devices(),
        client.places(),
      ]);
      if (pendingLoad.current !== request) return;
      setDevices(
        request.updates.reduce(
          (current, update) => update(current),
          nextDevices,
        ),
      );
      setPlaces(request.places ?? nextPlaces);
    } finally {
      if (pendingLoad.current === request) pendingLoad.current = null;
    }
  }, [client]);

  const apply = useCallback(
    (message: LiveMessage) => {
      if (message.type === "places") {
        if (pendingLoad.current) pendingLoad.current.places = message.places;
        setPlaces(message.places);
        return;
      }
      if (message.type !== "device") return;
      const { id, device } = message;
      updateDevices((current) => {
        if (!device) {
          return current.filter((each) => each.id !== id);
        }
        return current.some((each) => each.id === id)
          ? current.map((each) => (each.id === id ? device : each))
          : [...current, device];
      });
    },
    [updateDevices],
  );

  return { places, devices, load, apply };
}

export type Devices = ReturnType<typeof useDevices>;
