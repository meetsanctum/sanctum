import { getResponder, type CiaoService } from "@homebridge/ciao";
import { readdirSync, realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";

// The host announces itself on the home network as `_sanctum._tcp`, so apps
// list it and nobody types an address. The manager runs on the host's network
// to do this; the service points at the core, which is what clients talk to.

export const serviceType = "sanctum";

export type Announcement = {
  name: string;
  hostId: string;
  // The home the core serves; none until a core with home ids reports it.
  homeId?: string;
  claimed: boolean;
  port: number;
};

// `id` is the host's, and `home` the home's: apps follow a home by its id
// onto another host.
export function txtRecord(announcement: Announcement) {
  return {
    id: announcement.hostId,
    ...(announcement.homeId && { home: announcement.homeId }),
    claimed: announcement.claimed ? "1" : "0",
  };
}

const virtualInterface =
  /^(lo|docker|br-|veth|virbr|cni|flannel|tailscale|wg|tun|tap|utun|awdl|llw|bridge|anpi|gif|stf)/;

// The host's own network interfaces. Docker's bridges are left out so the
// host never advertises an address only containers can reach. On Linux this
// lists interfaces that are down too, so Wi-Fi that connects after the
// manager starts is still covered.
export function lanInterfaces() {
  try {
    return readdirSync("/sys/class/net").filter(
      (name) => !realpathSync(`/sys/class/net/${name}`).includes("/virtual/"),
    );
  } catch {
    return Object.entries(networkInterfaces())
      .filter(
        ([name, addresses]) =>
          !virtualInterface.test(name) &&
          (addresses ?? []).some((address) => !address.internal),
      )
      .map(([name]) => name);
  }
}

export async function startAnnouncing(
  announcement: Announcement,
  log: (message: string) => void,
) {
  const interfaces = lanInterfaces();
  const responder = getResponder({ interface: interfaces });
  const service: CiaoService = responder.createService({
    name: announcement.name,
    type: serviceType,
    port: announcement.port,
    txt: txtRecord(announcement),
  });
  let current = announcement;
  service.on("name-change", (name) => log(`mDNS: announcing as "${name}"`));
  await service.advertise();
  log(
    `mDNS: announcing _${serviceType}._tcp "${announcement.name}" on ${interfaces.join(", ")}`,
  );

  return {
    // What the core last reported.
    setHome(report: { claimed: boolean; homeId?: string }) {
      const { claimed, homeId } = report;
      if (claimed === current.claimed && homeId === current.homeId) {
        return;
      }
      current = { ...current, claimed, homeId };
      service.updateTxt(txtRecord(current));
      log(
        `mDNS: announcing claimed=${claimed ? 1 : 0}${homeId ? ` home=${homeId}` : ""}`,
      );
    },

    async stop() {
      await service.end();
      await responder.shutdown();
    },
  };
}
