import type {
  DeviceInfo,
  Hearing,
  Places,
  RequestLanguage,
} from "@meetsanctum/app-sdk";
import { useAppClient } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

// What the Assistant's page shows, read once and then followed live: how
// speech recognition is doing, the smart speakers (devices whose
// microphones listen) and the rooms they're in. Choosing a language asks the
// app, and remembers the one smart speakers keep hearing in meanwhile.

/** A device a person talks to: one whose microphones listen. */
export const isSmartSpeaker = (device: DeviceInfo) =>
  device.capabilities.some(
    ({ kind, features }) =>
      kind === "audio" && (features as { listens?: boolean }).listens === true,
  );

const byName = (a: DeviceInfo, b: DeviceInfo) => a.name.localeCompare(b.name);

export function useAssistant() {
  const client = useAppClient();
  const [hearing, setHearing] = useState<Hearing>();
  const [speakers, setSpeakers] = useState<DeviceInfo[]>();
  const [rooms, setRooms] = useState<Places["rooms"]>([]);
  const [hasFailed, setHasFailed] = useState(false);
  // The language smart speakers heard in before someone chose another here,
  // until the new one is ready.
  const [switchingFrom, setSwitchingFrom] = useState<RequestLanguage | null>(
    null,
  );
  const [isChoosing, setIsChoosing] = useState(false);
  const reading = useRef(0);

  const load = useCallback(async () => {
    const current = ++reading.current;
    try {
      const [nextHearing, devices, places] = await Promise.all([
        client.hearing(),
        client.devices(),
        client.places(),
      ]);
      if (current !== reading.current) return;
      setHearing(nextHearing);
      setSpeakers(devices.filter(isSmartSpeaker).sort(byName));
      setRooms(places.rooms);
      setHasFailed(false);
    } catch {
      if (current === reading.current) setHasFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
    const unsubscribe = client.subscribe({
      refresh: () => void load(),
      message(message) {
        if (message.type === "hearing") {
          setHearing(message.hearing);
          if (message.hearing.state === "ready") setSwitchingFrom(null);
        } else if (message.type === "places") {
          setRooms(message.places.rooms);
        } else if (message.type === "device") {
          setSpeakers((current) => {
            if (!current) return current;
            const others = current.filter(({ id }) => id !== message.id);
            return message.device && isSmartSpeaker(message.device)
              ? [...others, message.device].sort(byName)
              : others;
          });
        }
      },
    });
    return () => {
      reading.current++;
      unsubscribe();
    };
  }, [client, load]);

  /** Sets the home's language; false when it was refused. */
  const choose = useCallback(
    async (language: RequestLanguage) => {
      const before = hearing;
      if (!before || before.language === language) return true;
      setIsChoosing(true);
      try {
        await client.call("assistant.language", { language });
        // Speakers hear in the old one only once it was ready there.
        setSwitchingFrom(before.state === "ready" ? before.language : null);
        return true;
      } catch {
        return false;
      } finally {
        setIsChoosing(false);
      }
    },
    [client, hearing],
  );

  const roomName = useCallback(
    (id: string | null) => rooms.find((room) => room.id === id)?.name ?? null,
    [rooms],
  );

  return {
    hearing,
    speakers,
    roomName,
    hasFailed,
    switchingFrom,
    isChoosing,
    choose,
    reload: load,
  };
}
