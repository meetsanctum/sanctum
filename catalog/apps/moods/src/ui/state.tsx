import { useAppClient } from "@meetsanctum/ui-sdk";
import { createContext, useContext, useEffect, type ReactNode } from "react";

import { useDevices, type Devices } from "./devices";
import { useMoods, type Moods } from "./moods";
import { useMotion, type Motion } from "./motion";
import { useSchedules, type Schedules } from "./schedules";

// What Moods loads once for everything its pages show: the devices, places,
// moods, schedules and what motion does in each room, read again whenever the live connection comes back
// or the shell refreshes, and the devices and places followed through the
// live updates in between.

export type MoodsApp = Devices & {
  moods: Moods;
  schedules: Schedules;
  motion: Motion;
};

const MoodsAppContext = createContext<MoodsApp | null>(null);

export function MoodsProvider(props: { children: ReactNode }) {
  const client = useAppClient();
  const devices = useDevices();
  const moods = useMoods();
  const schedules = useSchedules();
  const motion = useMotion();
  const { load, apply } = devices;
  const { load: loadMoods } = moods;
  const { load: loadSchedules } = schedules;
  const { load: loadMotion } = motion;

  useEffect(() => {
    const reload = () => {
      void load().catch(() => undefined);
      void loadMoods().catch(() => undefined);
      void loadSchedules().catch(() => undefined);
      void loadMotion().catch(() => undefined);
    };
    reload();
    return client.subscribe({ message: apply, refresh: reload });
  }, [client, load, apply, loadMoods, loadSchedules, loadMotion]);

  return (
    <MoodsAppContext.Provider value={{ ...devices, moods, schedules, motion }}>
      {props.children}
    </MoodsAppContext.Provider>
  );
}

export function useMoodsApp(): MoodsApp {
  const app = useContext(MoodsAppContext);
  if (!app) {
    throw new Error("useMoodsApp() needs Moods' provider around it");
  }
  return app;
}
