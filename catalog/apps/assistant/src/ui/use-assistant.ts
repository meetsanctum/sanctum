import type {
  DeviceInfo,
  Hearing,
  LiveDevice,
  Places,
} from "@meetsanctum/app-sdk";
import { compare, useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { listeningAudio } from "./words";

// What the Assistant's page shows, read once and then followed live: how
// speech recognition is doing, the smart speakers (devices whose
// microphones listen) and the rooms they're in.

const byName = (a: DeviceInfo, b: DeviceInfo) => compare("en")(a.name, b.name);

function updateSpeakers(current: DeviceInfo[], { id, device }: LiveDevice) {
  if (device && listeningAudio(device)) {
    return [...current.filter((each) => each.id !== id), device].sort(byName);
  }
  return current.some((each) => each.id === id)
    ? current.filter((each) => each.id !== id)
    : current;
}

type PendingRead = {
  hearing?: Hearing;
  rooms?: Places["rooms"];
  devices: Map<string, LiveDevice>;
};

export function useAssistant() {
  const client = useAppClient();
  const [hearing, setHearing] = useState<Hearing>();
  const [speakers, setSpeakers] = useState<DeviceInfo[]>();
  const [rooms, setRooms] = useState<Places["rooms"]>([]);
  const [hasFailed, setHasFailed] = useState(false);
  const pending = useRef<PendingRead | undefined>(undefined);

  const load = useCallback(async () => {
    const reading: PendingRead = { devices: new Map() };
    pending.current = reading;
    try {
      const [nextHearing, devices, places] = await Promise.all([
        client.hearing(),
        client.devices(),
        client.places(),
      ]);
      if (pending.current !== reading) return;
      let nextSpeakers = devices.filter(listeningAudio).sort(byName);
      for (const update of reading.devices.values()) {
        nextSpeakers = updateSpeakers(nextSpeakers, update);
      }
      setHearing(reading.hearing ?? nextHearing);
      setSpeakers(nextSpeakers);
      setRooms(reading.rooms ?? places.rooms);
      setHasFailed(false);
    } catch {
      if (pending.current === reading) setHasFailed(true);
    } finally {
      if (pending.current === reading) pending.current = undefined;
    }
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe({
      refresh: () => void load(),
      message(message) {
        const reading = pending.current;
        if (message.type === "hearing") {
          if (reading) reading.hearing = message.hearing;
          setHearing(message.hearing);
        } else if (message.type === "places") {
          if (reading) reading.rooms = message.places.rooms;
          setRooms(message.places.rooms);
        } else if (message.type === "device") {
          reading?.devices.set(message.id, message);
          setSpeakers((current) =>
            current ? updateSpeakers(current, message) : current,
          );
        }
      },
    });
    void load();
    return () => {
      pending.current = undefined;
      unsubscribe();
    };
  }, [client, load]);

  const roomName = useCallback(
    (id: string | null) => rooms.find((room) => room.id === id)?.name ?? null,
    [rooms],
  );

  return {
    hearing,
    speakers,
    roomName,
    hasFailed,
    reload: load,
  };
}
