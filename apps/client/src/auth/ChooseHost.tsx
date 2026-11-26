import { CircleCheck, House, Plus, Wifi } from "lucide-react";
import { useEffect, useState } from "react";

import { productName } from "../brand";
import { coreBaseUrl } from "../core-url";
import { getShell, type FoundHost } from "../shell";
import { hostStatus } from "./device";
import { Sheet, SheetRow, SheetRowsLoading, SheetStatus } from "./sheet";

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
    // Without discovery, the one core is asked again every few seconds
    // until it answers, so "Still looking…" is true here too.
    const controller = new AbortController();
    let retry: number | undefined;
    const url = coreBaseUrl();
    const ask = () => {
      hostStatus(url, controller.signal)
        .then((status) => {
          setHosts([
            {
              id: status.hostId,
              homeId: status.homeId,
              name: productName,
              claimed: status.claimed,
              url,
            },
          ]);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setSearched(true);
          retry = window.setTimeout(ask, 5_000);
        });
    };
    ask();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      window.clearTimeout(timer);
    };
  }, []);

  return { hosts, searched };
}

// The address shows where two new homes, or two set-up homes with the same
// name, need to be told apart.
function detailOf(host: FoundHost, hosts: readonly FoundHost[]) {
  const namesake = hosts.some(
    (other) =>
      other !== host &&
      other.claimed === host.claimed &&
      (!host.claimed || other.name === host.name),
  );
  const address = namesake ? new URL(host.url).hostname : undefined;
  if (!host.claimed) {
    return address ? `Ready to set up · ${address}` : "Ready to set up";
  }
  return address;
}

// What to check while nothing answers: things people can see and change,
// not in any order.
const checks = [
  "This device is on your home Wi‑Fi, not a guest network.",
  `${productName} is switched on and connected to the same network.`,
  "Your router lets devices see each other. Some routers call blocking this “client isolation”.",
];

export function ChooseHost(props: {
  notice?: string;
  onChoose: (host: FoundHost) => void;
}) {
  const { hosts, searched } = useHosts();
  const notice = props.notice && (
    <p
      role="status"
      className="-mt-2 mb-0 text-center text-[15px] leading-[21px] text-balance"
    >
      {props.notice}
    </p>
  );

  if (hosts.length === 0 && searched) {
    return (
      <Sheet
        glyph={Wifi}
        title="No home found yet"
        subtitle="It shows up here as soon as this device finds it. In the meantime, check these."
      >
        {notice}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {checks.map((check) => (
            <li
              key={check}
              className="flex items-start gap-3 text-[15px] leading-[21px]"
            >
              <CircleCheck
                aria-hidden="true"
                className="mt-px size-5 shrink-0 text-muted-foreground"
                strokeWidth={1.75}
              />
              {check}
            </li>
          ))}
        </ul>
        <SheetStatus>Still looking…</SheetStatus>
      </Sheet>
    );
  }

  return (
    <Sheet
      glyph={House}
      title="Choose your home"
      subtitle="Homes on this network."
    >
      {notice}
      {hosts.length > 0 ? (
        <>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {hosts.map((host) => (
              <li key={host.id}>
                <SheetRow
                  icon={host.claimed ? House : Plus}
                  name={host.claimed ? host.name : "New home"}
                  detail={detailOf(host, hosts)}
                  onClick={() => props.onChoose(host)}
                />
              </li>
            ))}
          </ul>
          <p className="m-0 text-center text-[13px] leading-[18px] text-balance text-muted-foreground">
            Don’t see your home? Check that this device is on your home Wi‑Fi,
            not a guest network.
          </p>
        </>
      ) : (
        <>
          <SheetRowsLoading />
          <SheetStatus>Looking for homes…</SheetStatus>
        </>
      )}
    </Sheet>
  );
}
