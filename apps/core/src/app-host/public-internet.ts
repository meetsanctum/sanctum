import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// The internet as apps reach it: only public addresses, never the home's own
// network, the host itself or other special-purpose ranges, whatever a name
// resolves to. The check happens as each connection is made, on the very
// addresses it connects to, so a name that resolves anew between a check and
// the connection cannot slip through to the home's network.

const special = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier-grade NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  special.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["2001::", 23], // IETF protocol assignments, Teredo among them
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which carries an IPv4 address
  ["3fff::", 20], // documentation
] as const) {
  special.addSubnet(network, prefix, "ipv6");
}

// IANA currently assigns native global unicast addresses within 2000::/3:
// https://www.iana.org/assignments/ipv6-address-space
// Everything outside it is refused, including translation prefixes that
// could carry a private IPv4 destination. BlockList also recognizes every
// spelling of IPv4-mapped IPv6, which follows the IPv4 exclusions above.
const internet = new BlockList();
internet.addSubnet("0.0.0.0", 0, "ipv4");
internet.addSubnet("2000::", 3, "ipv6");

/** Whether an address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  return internet.check(address, type) && !special.check(address, type);
}

class NotPublic extends Error {
  readonly code = "ENOTPUBLIC";
}

/**
 * A name lookup that answers only when every address the name resolves
 * to is public, as connections use it.
 */
export function publicOnly(lookup: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, found) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const addresses = found as unknown as LookupAddress[];
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => !isPublicAddress(address))
      ) {
        callback(
          new NotPublic(`${hostname} is not on the public internet`),
          "",
          0,
        );
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}

/** The core's fetch for apps, which connects to public addresses only. */
export function publicInternet(): typeof fetch {
  const dispatcher = new Agent({
    connect: { lookup: publicOnly(dnsLookup as LookupFunction) },
  });
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof fetch;
}
