import type { AppInfo } from "@meetsanctum/app-sdk";
import { PageBar } from "@meetsanctum/ui-sdk";
import { Info } from "lucide-react";

import { NoticeCard } from "./app-state";
import { productName } from "./brand";

// An app's pages come from the home, each in a frame, built against the
// home's kit and speaking a version of the bridge to the shell. When the
// two sides can't work together, a notice says which is too old, in the
// page's place. What the app adds to the home is data the shell draws, so
// that keeps working.

export type PageMismatch =
  // The home's pages speak a newer bridge than this client.
  | { needs: "client" }
  // A page needs a newer home: its kit is older than the page was built
  // against, or speaks an older bridge than this client.
  | { needs: "sanctum" }
  // A page was built against an older kit than the home's, and needs a new
  // build of its app.
  | { needs: "pages" };

/**
 * What takes the place of a page that doesn't match, in the page's own
 * place: an app's page with the app's name in the top bar, a device page
 * in the device's detail without.
 */
export function PageDoesntMatch(props: {
  app: AppInfo;
  mismatch: PageMismatch;
  isDevicePage?: boolean;
}) {
  const { app, mismatch } = props;
  const keeps = `What ${app.name} adds to the home keeps working.`;
  return (
    <>
      {!props.isDevicePage && <PageBar title={app.name} />}
      {mismatch.needs === "sanctum" ? (
        <NoticeCard
          Icon={Info}
          title={`This page needs a newer ${productName}`}
          line={`Update ${productName} to open it. ${keeps}`}
        />
      ) : mismatch.needs === "pages" ? (
        <NoticeCard
          Icon={Info}
          title={`This page needs an update of ${app.name}`}
          line={`It was made for an older ${productName}. ${keeps}`}
        />
      ) : (
        <NoticeCard
          Icon={Info}
          title="To open this page, update this app"
          line={`It's too old for the pages of ${app.name} ${app.version}. ${keeps}`}
        />
      )}
    </>
  );
}
