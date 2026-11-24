import type { Tile } from "@meetsanctum/ui-sdk";
import { useMemo, useSyncExternalStore, type ComponentProps } from "react";

import { DeviceDetail } from "./device-detail";
import { useHomeDevices } from "./home-devices";
import { tileKey } from "./device-tiles";

type Opened = {
  /** The tile whose detail is open, kept while it closes. */
  key: string | null;
  open: boolean;
  /** A room's tile opens on the device's first page. */
  openFirstPage: boolean;
};

// Which device's detail is open, kept apart from Home's own state: opening
// or closing a device's detail then draws only the detail, not the whole
// shell under it.
function createOpenDevice() {
  let opened: Opened = { key: null, open: false, openFirstPage: false };
  const listeners = new Set<() => void>();
  const set = (next: Opened) => {
    opened = next;
    for (const listener of listeners) listener();
  };
  return {
    open: (tile: Tile) =>
      set({ key: tile.key, open: true, openFirstPage: false }),
    openFromRoom: (tile: Tile) =>
      set({
        key: tileKey(tile.deviceId, tile.capabilityId),
        open: true,
        openFirstPage: true,
      }),
    close: () => {
      if (opened.open) set({ ...opened, open: false });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => opened,
  };
}

export type OpenDevice = ReturnType<typeof createOpenDevice>;

export function useOpenDevice() {
  return useMemo(createOpenDevice, []);
}

/** The open device's detail, the only part that draws as it opens or closes. */
export function OpenDeviceDetail(
  props: Omit<
    ComponentProps<typeof DeviceDetail>,
    "tileKey" | "openFirstPage" | "open" | "onClose" | "devices"
  > & { opened: OpenDevice },
) {
  const { opened, ...detail } = props;
  const current = useSyncExternalStore(opened.subscribe, opened.read);
  const devices = useHomeDevices();
  return (
    <DeviceDetail
      {...detail}
      devices={devices}
      tileKey={current.key}
      openFirstPage={current.openFirstPage}
      open={current.open}
      onClose={opened.close}
    />
  );
}
