import type { AppInfo, AvailableApp } from "@meetsanctum/app-sdk";
import { useEffect, useState } from "react";

import { coreJson } from "./core-fetch";

// The apps the home could add (GET /api/apps/available), read as Settings
// opens, whenever the home's apps change and after closing an add sheet, so
// another look checks what's changed. A read that fails leaves it as it was.

export function useAvailableApps(installed: readonly AppInfo[]) {
  const [available, setAvailable] = useState<AvailableApp[]>([]);
  const [revision, setRevision] = useState(0);
  // Which apps the home has, not how each is doing.
  const ids = installed
    .map((app) => app.id)
    .sort()
    .join(" ");
  useEffect(() => {
    let isCurrent = true;
    coreJson<AvailableApp[]>("/api/apps/available").then(
      (list) => {
        // An answer that isn't a list is no answer.
        if (isCurrent && Array.isArray(list)) setAvailable(list);
      },
      () => undefined,
    );
    return () => {
      isCurrent = false;
    };
  }, [ids, revision]);
  // One added meanwhile isn't offered while the list is read again.
  const has = new Set(ids.split(" "));
  return {
    available: available.filter((app) => !has.has(app.id)),
    refresh: () => setRevision((current) => current + 1),
  };
}
