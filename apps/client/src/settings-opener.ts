import type { PageParams } from "@meetsanctum/ui-sdk";
import { createContext, useContext } from "react";

// Opens one of Settings' pages over the page that's open, for the shell's
// sheets that lead to their fix from deep inside, such as an app's Add sheet
// opening System at its Storage card. The signed-in screen provides it,
// keeping a single back entry when the requested page is already open.

export type SettingsOpener = (page: string, params?: PageParams) => void;

const SettingsOpenerContext = createContext<SettingsOpener | undefined>(
  undefined,
);

export const SettingsOpenerProvider = SettingsOpenerContext.Provider;

export const useSettingsOpener = () => useContext(SettingsOpenerContext);
