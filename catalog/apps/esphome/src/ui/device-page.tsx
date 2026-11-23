import { Card, useAppClient, type DevicePageProps } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import type { DeviceFacts } from "../facts";
import type { DeviceAction } from "../page";
import { SpeakerCards } from "./speaker-cards";

// ESPHome's page in its devices' detail: on a smart speaker its microphones
// and ring first, then how the device is reached, what it runs, its Wi-Fi
// signal, and what it has that the app doesn't bring in.

/** A Wi-Fi signal in words, then in dBm with a true minus sign. */
export function signalWords(dBm: number) {
  const words = dBm >= -67 ? "Good" : dBm >= -75 ? "Fair" : "Weak";
  return `${words}, ${dBm < 0 ? "−" : ""}${Math.abs(dBm)} dBm`;
}

/** Names in a sentence: "A", "A and B", "A, B and C". */
export function listOf(names: readonly string[]) {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function Row(props: { label: string; children: string; alert?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 px-2.5 py-2 text-[15px] leading-5">
      <dt className="shrink-0 text-muted-foreground">{props.label}</dt>
      <dd
        className={
          props.alert
            ? "m-0 min-w-0 truncate text-right text-destructive"
            : "m-0 min-w-0 truncate text-right"
        }
      >
        {props.children}
      </dd>
    </div>
  );
}

export function DevicePage(props: DevicePageProps) {
  const { device } = props;
  const client = useAppClient();
  const [facts, setFacts] = useState<DeviceFacts | null>(null);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    let current = true;
    client
      .call<DeviceAction>("esphome.device", { device: device.id })
      .then((loaded) => {
        if (!current) return;
        setFacts(loaded);
        setProblem(false);
      })
      .catch(() => {
        if (current) setProblem(true);
      });
    return () => {
      current = false;
    };
  }, [client, device.id, device.availability, device.problem?.id]);

  if (problem && !facts) {
    return (
      <p
        role="alert"
        className="m-0 px-1 text-[15px] leading-5 text-muted-foreground"
      >
        Couldn't load how it's connected. Open its detail again to try again.
      </p>
    );
  }
  if (!facts) return null;
  return (
    <div className="flex flex-col gap-5">
      {device.type === "smart-speaker" && (
        <SpeakerCards key={device.id} device={device} />
      )}
      <ConnectionSection facts={facts} />
    </div>
  );
}

function ConnectionSection(props: { facts: DeviceFacts }) {
  const { facts } = props;
  return (
    <section aria-label="How it's connected" className="flex flex-col gap-3">
      <Card>
        <dl className="m-0">
          <Row label="Address">{facts.address.replace(/:6053$/, "")}</Row>
          <Row label="Connection" alert={!facts.encrypted}>
            {facts.encrypted ? "Encrypted" : "Not encrypted"}
          </Row>
          {facts.version && (
            <Row label="Firmware">{`ESPHome ${facts.version}`}</Row>
          )}
          {facts.signal !== null && (
            <Row label="Wi-Fi">{signalWords(facts.signal)}</Row>
          )}
        </dl>
      </Card>
      {facts.unused.length > 0 && (
        <p className="m-0 px-1 text-[15px] leading-5 text-muted-foreground">
          It also has {listOf(facts.unused)}, which this app doesn't bring into
          your home.
        </p>
      )}
    </section>
  );
}
