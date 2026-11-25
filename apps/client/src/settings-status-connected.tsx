import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import type { ClientInfo, PersonInfo } from "@meetsanctum/auth-protocol";
import { useHomeClock } from "@meetsanctum/ui-sdk";
import { House } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar, Row, Section } from "./components";
import { coreJson } from "./core-fetch";
import { platformNames } from "./platforms";
import { lastAtText } from "./system-status";
import { everyWhileShown } from "./while-shown";

// Connected now, Status' last section: each screen with a live connection
// open, drawn as Settings → Clients draws it, this device first and then the
// longest connected. Renaming and removing stay in Clients.

export function connectedDetail(
  clock: HomeClock,
  client: ClientInfo,
  person: PersonInfo | undefined,
  now = new Date(),
) {
  return [
    client.kind === "shared" ? "Shared" : (person?.name ?? "Personal"),
    platformNames[client.platform],
    client.current
      ? "this device"
      : `since ${lastAtText(clock, client.connectedSince!, now)}`,
  ].join(" · ");
}

export function ConnectedSection() {
  const clock = useHomeClock();
  const [clients, setClients] = useState<ClientInfo[]>();
  const [people, setPeople] = useState<PersonInfo[]>([]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const [nextClients, nextPeople] = await Promise.all([
          coreJson<ClientInfo[]>("/api/auth/clients"),
          coreJson<PersonInfo[]>("/api/people"),
        ]);
        if (!current) return;
        setClients(nextClients);
        setPeople(nextPeople);
      } catch {
        // Asked again in a moment.
      }
    };
    void load();
    const stopPolling = everyWhileShown(5_000, () => void load());
    return () => {
      current = false;
      stopPolling();
    };
  }, []);

  if (!clients) return null;
  const connected = clients
    .filter((client) => client.connectedSince !== null)
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (a.connectedSince ?? "").localeCompare(b.connectedSince ?? ""),
    );
  return (
    <Section
      id="status-connected"
      title="Connected Now"
      hint={`${connected.length} of ${clients.length} ${clients.length === 1 ? "client" : "clients"}`}
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {connected.map((client) => {
          const person = people.find(({ id }) => id === client.personId);
          return (
            <li key={client.id} className="flex items-center gap-3">
              {person ? (
                <Avatar name={person.name} colour={person.colour} />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
                >
                  <House className="size-4" />
                </span>
              )}
              <Row
                title={client.name}
                detail={connectedDetail(clock, client, person)}
              />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
