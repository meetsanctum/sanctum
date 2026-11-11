import { useCallback, useEffect, useState } from "react";

import { CertificateChanged } from "./auth/CertificateChanged";
import { ChooseHost } from "./auth/ChooseHost";
import { ClaimHost } from "./auth/ClaimHost";
import { PairDevice } from "./auth/PairDevice";
import { replaceClient, selectHost } from "./auth/session";
import { SignIn } from "./auth/SignIn";
import { onTokenInvalid } from "./core-fetch";
import { Home } from "./Home";
import { getShell, type FoundHost, type StoredHost } from "./shell";

// Signing in or pairing again checks a stored host whose certificate changed
// (`recheck`), and Back returns to that screen. The same home may answer
// from another host (`found`), as after a restore onto new hardware.
type View =
  | { name: "starting" }
  | { name: "choose"; notice?: string }
  | { name: "claim"; host: FoundHost }
  | { name: "sign-in"; host: FoundHost; recheck?: StoredHost }
  | { name: "pair"; host: FoundHost; recheck?: StoredHost }
  | { name: "home"; host: StoredHost }
  | { name: "changed"; host: StoredHost; url: string; found?: FoundHost };

const views = new Set([
  "choose",
  "claim",
  "sign-in",
  "pair",
  "home",
  "changed",
]);

// A view the shell kept across a fresh session (Shell.trust.resumed).
function isView(value: unknown): value is View {
  return (
    typeof value === "object" &&
    value !== null &&
    views.has((value as { name?: unknown }).name as string)
  );
}

export function App() {
  const [view, setView] = useState<View>({ name: "starting" });

  useEffect(() => {
    const shell = getShell();
    void Promise.all([
      shell.credentials.load(),
      shell.trust?.resumed() ?? null,
    ]).then(([stored, resumed]) => {
      if (stored) {
        selectHost(stored);
      }
      setView(
        isView(resumed)
          ? resumed
          : stored
            ? { name: "home", host: stored }
            : { name: "choose" },
      );
    });
  }, []);

  // The core reported this device's token invalid: it was removed, and
  // nothing else unpairs it.
  useEffect(
    () =>
      onTokenInvalid((token) => {
        const removed = {
          name: "choose",
          notice: "This device was removed.",
        } as const;
        void getShell().credentials.forget(token, removed);
        setView(removed);
      }),
    [],
  );

  // A first contact checks the chosen host, before anything is typed; any
  // other screen trusts only the stored host's pin. A change of trust may
  // bring the page back in a fresh session, on this view.
  const checking =
    view.name === "claim" || view.name === "sign-in" || view.name === "pair"
      ? view.host.id
      : null;
  // Runs when the host being checked or the screen changes, with the view
  // that render committed; a new view object alone changes no trust.
  useEffect(() => {
    if (view.name !== "starting") {
      void getShell().trust?.check(checking, view);
    }
  }, [checking, view.name]);

  // While the changed screen shows, discovery may still find the home on
  // another host, as when a restored host announced itself only after the
  // old address failed its check. Checking again goes to that host, at the
  // address that failed if it is there.
  const changedHome = view.name === "changed" ? view.host.homeId : null;
  const changedUrl = view.name === "changed" ? view.url : null;
  useEffect(() => {
    if (!changedHome) return;
    return getShell().discovery?.watch((hosts) => {
      const same = hosts.filter((host) => host.homeId === changedHome);
      const found = same.find((host) => host.url === changedUrl) ?? same[0];
      if (!found) return;
      setView((current) =>
        current.name === "changed" &&
        (current.found?.id !== found.id || current.found.url !== found.url)
          ? { ...current, found }
          : current,
      );
    });
  }, [changedHome, changedUrl]);

  const choose = useCallback((host: FoundHost) => {
    setView(host.claimed ? { name: "sign-in", host } : { name: "claim", host });
  }, []);
  const back = useCallback(() => setView({ name: "choose" }), []);
  const home = useCallback(
    (host: StoredHost) => setView({ name: "home", host }),
    [],
  );
  const changed = useCallback(
    (host: StoredHost, url: string, found?: FoundHost) =>
      setView({ name: "changed", host, url, found }),
    [],
  );

  switch (view.name) {
    case "starting":
      return null;
    case "choose":
      return <ChooseHost notice={view.notice} onChoose={choose} />;
    case "claim":
      return <ClaimHost host={view.host} onBack={back} onClaimed={home} />;
    case "sign-in": {
      const { host, recheck } = view;
      return (
        <SignIn
          host={host}
          recheck={recheck}
          onBack={recheck ? () => changed(recheck, host.url, host) : back}
          onSignedIn={(stored) => {
            if (recheck) void replaceClient(recheck, stored);
            home(stored);
          }}
          onShared={() => setView({ name: "pair", host, recheck })}
          onForgotten={back}
        />
      );
    }
    case "pair": {
      const { host, recheck } = view;
      return (
        <PairDevice
          host={host}
          recheck={recheck}
          onForgotten={back}
          onBack={
            recheck?.kind === "shared"
              ? () => changed(recheck, host.url, host)
              : () => setView({ name: "sign-in", host, recheck })
          }
          onPaired={home}
        />
      );
    }
    case "home":
      return (
        <Home
          host={view.host}
          onHostMoved={home}
          onSignedOut={back}
          onCertificateChanged={changed}
        />
      );
    case "changed": {
      const { host: stored, url, found } = view;
      // Signing in again pins the new CA and stores the host it found, for
      // the same home: checkHost refuses another one.
      const host = {
        id: found?.id ?? stored.hostId,
        homeId: stored.homeId,
        name: stored.name,
        claimed: true,
        url: found?.url ?? url,
      };
      return (
        <CertificateChanged
          host={stored}
          onCheck={() =>
            setView(
              stored.kind === "personal"
                ? { name: "sign-in", host, recheck: stored }
                : { name: "pair", host, recheck: stored },
            )
          }
          onRetry={() => home(stored)}
          // A host that was reset has none of this device's sign-ins: it is
          // set up again, or another host is chosen.
          onForgotten={back}
        />
      );
    }
  }
}
