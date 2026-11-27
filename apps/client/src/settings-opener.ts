import type { PageParams } from "@meetsanctum/ui-sdk";
import { createContext, useContext } from "react";

// Opens one of Settings' pages over the page that's open, for the shell's
// sheets that lead to their fix from deep inside, such as an app's Add sheet
// opening System at its Storage card. The signed-in screen provides it, and
// leaves the page as it is where it's already the one asked for; outside it
// there's no way there, and such a sheet offers none.

export type SettingsOpener = (page: string, params?: PageParams) => void;

const SettingsOpenerContext = createContext<SettingsOpener | undefined>(
  undefined,
);

export const SettingsOpenerProvider = SettingsOpenerContext.Provider;

export const useSettingsOpener = () => useContext(SettingsOpenerContext);
