import { useEffect, useState } from "react";

import { productName } from "../brand";
import { Sheet } from "../components";
import { coreBaseUrl } from "../core-url";
import { KnotLoader } from "../knot-loader";
import { getShell, type FoundHost } from "../shell";
import { hostStatus } from "./device";
import { Button } from "@meetsanctum/ui-sdk";

// The hosts on the home network. Nobody types an address: the shell browses
// for them, and a plain browser in development uses the core it was pointed
// at.
function useHosts() {
  const [hosts, setHosts] = useState<FoundHost[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearched(true), 6_000);
    const discovery = getShell().discovery;
    if (discovery) {
      const stop = discovery.watch(setHosts);
      return () => {
        stop();
        window.clearTimeout(timer);
      };
    }
    let current = true;
    const url = coreBaseUrl();
    hostStatus(url)
      .then((status) => {
        if (current) {
          setHosts([
            {
              id: status.hostId,
              homeId: status.homeId,
              name: productName,
              claimed: status.claimed,
              url,
            },
          ]);
        }
      })
      .catch(() => undefined)
      .finally(() => current && setSearched(true));
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, []);

  return { hosts, searched };
}

export function ChooseHost(props: {
  notice?: string;
  onChoose: (host: FoundHost) => void;
}) {
  const { hosts, searched } = useHosts();

  return (
    <Sheet
      title="Choose your home"
      intro={
        props.notice && (
          <p className="notice" role="status">
            {props.notice}
          </p>
        )
      }
    >
      {hosts.length > 0 ? (
        <ul className="rows">
          {hosts.map((host) => (
            <li key={host.id}>
              <Button
                variant="row"
                size="row"
                type="button"
                className="-mx-2.5 w-[calc(100%+20px)] justify-between"
                onClick={() => props.onChoose(host)}
              >
                <span className="row-main">
                  <strong>
                    {host.claimed ? host.name : "New home, ready to set up"}
                  </strong>
                  <span className="row-detail">
                    {new URL(host.url).hostname}
                  </span>
                </span>
                <span className="row-action">
                  {host.claimed ? "Sign in" : "Set up"}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : searched ? (
        <div className="empty">
          <p>No home found on this network.</p>
          <p className="muted">
            Check that this device is on your home Wi-Fi, not a guest network,
            and that your router lets devices find each other.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3" role="status">
          <KnotLoader className="size-7 shrink-0 text-(--secondary)" />
          <p className="muted">Looking for your home…</p>
        </div>
      )}
    </Sheet>
  );
}
