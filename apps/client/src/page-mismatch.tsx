import { isOlderVersion, type AppInfo } from "@meetsanctum/app-sdk";
import { PageBar, type AppUi } from "@meetsanctum/ui-sdk";
import { Info } from "lucide-react";

import { NoticeCard } from "./app-state";

// Pages come with the client, not the home, so a client's can be newer or
// older than the version the home runs, which a failed update or Go back
// makes likelier. A UI names the oldest version of its app it works with, by
// default the one it came with, and an app names the oldest of its pages it
// works with, which `pnpm manifest` raises when a version takes something
// away. Outside either the shell mounts none of that app's UI, and a notice
// takes the place of its pages. What it adds to the home is data the shell
// draws, so that keeps working. A client from before this can't check, and
// carries on as it did.

export type PageMismatch =
  // This client's pages need a newer version of the app than the home runs.
  | { needs: "app"; version: string }
  // The home's version needs newer pages than this client has.
  | { needs: "client" };

/** Whether this client's pages for an app work with the version the home runs. */
export function pageMismatch(
  info: Pick<AppInfo, "version" | "oldestPage">,
  ui: Pick<AppUi, "version" | "oldestApp">,
): PageMismatch | undefined {
  const oldestApp = ui.oldestApp ?? ui.version;
  if (isOlderVersion(info.version, oldestApp)) {
    return { needs: "app", version: oldestApp };
  }
  return info.oldestPage && isOlderVersion(ui.version, info.oldestPage)
    ? { needs: "client" }
    : undefined;
}

/** What takes the place of a page that doesn't match, in the page's own place. */
export function PageDoesntMatch(props: {
  app: AppInfo;
  mismatch: PageMismatch;
}) {
  const { app, mismatch } = props;
  return (
    <>
      <PageBar title={app.name} />
      {mismatch.needs === "app" ? (
        <NoticeCard
          Icon={Info}
          title={`This page needs ${app.name} ${mismatch.version} or later`}
          line={`It's on ${app.version}. What it adds to the home keeps working.`}
        />
      ) : (
        <NoticeCard
          Icon={Info}
          title="To open this page, update this app"
          line={`It's too old for ${app.name} ${app.version}. What ${app.name} adds to the home keeps working.`}
        />
      )}
    </>
  );
}
