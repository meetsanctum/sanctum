import type {
  AppInfo,
  AvailableApp,
  HardwareOffer,
  LiveMessage,
} from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { AddAppSheet } from "./add-app-sheet";
import { coreJson } from "./core-fetch";

// A Zigbee stick plugged in while the home has no app for it brings up that
// app's add sheet, opened with what happened, on every client that is open
// and the next one opened. Add adds it, as from Settings, and Cancel says no
// for every client: either ends it everywhere, as unplugging the stick does.
// It waits while another sheet is open, so it never covers what someone is
// doing.

/**
 * The offer as the core has it, followed live, and read again as the
 * connection comes back: only while the core answers, so a home that
 * doesn't is never asked.
 */
export function useHardwareOffer(live: LiveFeed, isOnline: boolean) {
  const [offer, setOffer] = useState<HardwareOffer | null>(null);
  useEffect(() => {
    if (!isOnline) return;
    let isCurrent = true;
    const read = () =>
      coreJson<{ offer: HardwareOffer | null }>("/api/hardware/offer").then(
        (answer) => {
          if (isCurrent) setOffer(answer.offer ?? null);
        },
        // A core from before offers has none to give.
        () => undefined,
      );
    void read();
    const stop = live.subscribe({
      message(message: LiveMessage) {
        if (message.type === "offer") setOffer(message.offer);
      },
      refresh: () => void read(),
    });
    return () => {
      isCurrent = false;
      stop();
    };
  }, [live, isOnline]);
  return offer;
}

/** What opens the sheet: "A Zigbee stick was plugged in". */
export const pluggedInWords = (offer: HardwareOffer) =>
  offer.sticks.length > 1
    ? "Zigbee sticks were plugged in"
    : "A Zigbee stick was plugged in";

// Whether a sheet or dialog is open, which an offer waits behind.
const isAnotherOpen = () =>
  document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;

export function StickOffer(props: {
  live: LiveFeed;
  /** Whether the core answers now. */
  isOnline: boolean;
  onAdded: (app: AppInfo) => void;
}) {
  const offer = useHardwareOffer(props.live, props.isOnline);
  const [app, setApp] = useState<AvailableApp>();
  // The offer this client has shown, so it opens once.
  const [shownId, setShownId] = useState<string>();

  // Waits for nothing else to be open, then reads the app it offers.
  useEffect(() => {
    if (!offer || offer.id === shownId) return;
    let isCurrent = true;
    const open = async () => {
      if (isAnotherOpen()) return;
      clearInterval(timer);
      const list = await coreJson<AvailableApp[]>("/api/apps/available").catch(
        () => [],
      );
      const found = Array.isArray(list)
        ? list.find((each) => each.id === offer.app)
        : undefined;
      if (!isCurrent || !found) return;
      setShownId(offer.id);
      setApp(found);
    };
    const timer = setInterval(() => void open(), 1_000);
    void open();
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [offer, shownId]);

  // Answered on another client, or unplugged.
  useEffect(() => {
    if (!offer) setApp(undefined);
  }, [offer]);

  return (
    <AddAppSheet
      app={offer ? app : undefined}
      lead={offer ? pluggedInWords(offer) : undefined}
      onAdded={(added) => {
        setApp(undefined);
        props.onAdded(added);
      }}
      onClose={() => {
        setApp(undefined);
        if (offer) {
          // Ended meanwhile, it's no to nothing.
          coreJson("/api/hardware/offer/dismiss", {
            method: "POST",
            json: { id: offer.id },
          }).catch(() => undefined);
        }
      }}
    />
  );
}
