import {
  maintenanceOf,
  type CapabilityInfo,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";

import { contactText } from "./contact";
import { width } from "./device-history";
import { Battery } from "./sensor-detail";

// A contact sensor's Contact page, the first of its detail: what it says
// now, as its tile does, with its battery at the foot, as on a sensor's
// Readings.

type Contact = Extract<CapabilityInfo, { kind: "contact" }>;

/** What it says now, as its tile does. */
function nowText(device: DeviceInfo, capability: Contact, now: number) {
  if (device.availability === "offline") {
    return device.leftAt === null ? "Offline" : "Not paired";
  }
  if (maintenanceOf(device, now) === "quiet") return "Not heard from";
  if (!capability.state) return "Waiting for a reading";
  return contactText(capability.state.open, capability.changedAt, now);
}

export function ContactPage(props: {
  device: DeviceInfo;
  capability: Contact;
  now: number;
}) {
  const { device, capability } = props;
  return (
    <div className={`${width} flex flex-col gap-10 [--history-width:480px]`}>
      <p className="m-0 text-2xl leading-8 font-light">
        {nowText(device, capability, props.now)}
      </p>
      <Battery level={device.battery} />
    </div>
  );
}
