import type {
  AppInfo,
  AvailableApp,
  HardwareOffer,
  LiveMessage,
} from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { AddAppSheet } from "./add-app-sheet";
import { CoreError, coreJson } from "./core-fetch";

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
function useHardwareOffer(live: LiveFeed, isOnline: boolean) {
  const [offer, setOffer] = useState<HardwareOffer | null>(null);
  useEffect(() => {
    if (!isOnline) {
      setOffer(null);
      return;
    }
    let readId = 0;
    const read = async () => {
      const id = ++readId;
      try {
        const answer = await coreJson<{ offer: HardwareOffer | null }>(
          "/api/hardware/offer",
        );
        if (id === readId) setOffer(answer.offer);
      } catch {
        // The next refresh tries again.
      }
    };
    const stop = live.subscribe({
      message(message: LiveMessage) {
        if (message.type !== "offer") return;
        // A read that began before this update may carry an older offer.
        readId += 1;
        setOffer(message.offer);
      },
      refresh: () => void read(),
    });
    void read();
    return () => {
      readId += 1;
      stop();
    };
  }, [live, isOnline]);
  return isOnline ? offer : null;
}

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
  if (!offer) return null;
  return <OfferedApp key={offer.id} offer={offer} onAdded={props.onAdded} />;
}

function OfferedApp(props: {
  offer: HardwareOffer;
  onAdded: (app: AppInfo) => void;
}) {
  const { offer } = props;
  const appId = offer.app;
  const [app, setApp] = useState<AvailableApp>();

  // Waits for nothing else to be open, then reads the app it offers.
  useEffect(() => {
    let isCurrent = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = async () => {
      if (!isAnotherOpen()) {
        try {
          const list = await coreJson<AvailableApp[]>("/api/apps/available");
          if (!isCurrent) return;
          const found = list.find((each) => each.id === appId);
          if (found && !isAnotherOpen()) {
            setApp(found);
            return;
          }
        } catch {
          // Keep waiting while the offer is current.
        }
      }
      if (isCurrent) timer = setTimeout(() => void open(), 1_000);
    };
    void open();
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [appId]);

  return (
    <AddAppSheet
      app={app}
      offerId={offer.id}
      lead={
        offer.sticks.length > 1
          ? "Zigbee sticks were plugged in"
          : "A Zigbee stick was plugged in"
      }
      onAdded={(added) => {
        setApp(undefined);
        props.onAdded(added);
      }}
      onClose={async () => {
        try {
          await coreJson("/api/hardware/offer/dismiss", {
            method: "POST",
            json: { id: offer.id },
          });
        } catch (error) {
          if (!(error instanceof CoreError) || error.code !== "conflict") {
            throw error;
          }
        }
        setApp(undefined);
      }}
    />
  );
}
