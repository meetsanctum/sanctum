import type { AppInfo, AvailableApp, DeviceOffer } from "@meetsanctum/app-sdk";
import { useEffect, useState } from "react";

import { AddAppSheet } from "./add-app-sheet";
import { coreJson } from "./core-fetch";

// An app the home could add that finds its devices on the home's network is
// offered in Add devices once some of them announce themselves: its card
// says how many were found, and pressing it opens the app's add sheet, read
// then, since it needs the local network and so asks rather than adding
// itself. Added, it finds them, and they're added from Devices found.

/** "2 ESPHome devices found", on its card. */
export const offerFoundWords = ({ name, found }: DeviceOffer) =>
  `${found} ${name} ${found === 1 ? "device" : "devices"} found`;

/** "2 ESPHome devices were found", above the sheet's title. */
const leadWords = ({ name, found }: DeviceOffer) =>
  found === 1
    ? `${/^[AEIOU]/i.test(name) ? "An" : "A"} ${name} device was found`
    : `${found} ${name} devices were found`;

export function OfferedAppSheet(props: {
  offer: DeviceOffer;
  apps: readonly AppInfo[];
  onAdded: () => void;
  onClose: () => void;
  restoreFocus: () => void;
  /** Its sheet couldn't be read. */
  onProblem: (problem: string) => void;
}) {
  const { offer, onClose, onProblem } = props;
  const appId = offer.app;
  const [app, setApp] = useState<AvailableApp>();

  useEffect(() => {
    let isCurrent = true;
    void coreJson<AvailableApp[]>("/api/apps/available")
      .then((list) => {
        if (!isCurrent) return;
        const found = list.find((each) => each.id === appId);
        // Added meanwhile, as on another device: nothing is left to add.
        if (found) setApp(found);
        else onClose();
      })
      .catch(() => {
        if (!isCurrent) return;
        onProblem("That did not work. Try again.");
        onClose();
      });
    return () => {
      isCurrent = false;
    };
  }, [appId, onClose, onProblem]);

  return (
    <AddAppSheet
      app={app}
      apps={props.apps}
      lead={leadWords(offer)}
      onAdded={props.onAdded}
      onClose={onClose}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        props.restoreFocus();
      }}
    />
  );
}
