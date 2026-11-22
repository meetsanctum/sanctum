import { ollamaPort } from "@meetsanctum/app-sdk";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Where a computer in the home is: an address on the home's network, never
// the internet, the host itself or a special range. A name is looked up once,
// when the source is added, and the address it gave is the one used from
// then on, so a name that later resolves elsewhere can't move it.

const home = new BlockList();
home.addSubnet("10.0.0.0", 8, "ipv4");
home.addSubnet("172.16.0.0", 12, "ipv4");
home.addSubnet("192.168.0.0", 16, "ipv4");
home.addSubnet("169.254.0.0", 16, "ipv4");
// IPv6 unique local addresses. Link-local ones need an interface to name,
// which an address typed into Settings doesn't carry.
home.addSubnet("fc00::", 7, "ipv6");

/** Whether an address is on a home's own network. */
export function isHomeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return home.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type HomeAddress = { host: string; port: number };

/** How an address typed in can't be used. */
export class AddressProblem extends Error {
  constructor(readonly problem: "unreachable" | "refused") {
    super(problem);
  }
}

/**
 * The address as typed, such as 192.168.1.40, 192.168.1.40:11500,
 * office-mac.local or [fd00::5]:11434, without a scheme or a path.
 */
export function parseAddress(typed: string): { name: string; port: number } {
  const text = typed.trim();
  if (text.length === 0 || text.length > 253 || /[/?#@\s]/.test(text)) {
    throw new AddressProblem("refused");
  }
  let name = text;
  let port = ollamaPort;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  const withPort = /^([^:]+):(\d+)$/.exec(text);
  if (bracketed) {
    name = bracketed[1]!;
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if (withPort) {
    name = withPort[1]!;
    port = Number(withPort[2]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AddressProblem("refused");
  }
  return { name, port };
}

/**
 * Where a typed address is, as an address on the home's network. Refused
 * when it, or every address its name gives, is anywhere else.
 */
export async function resolveHomeAddress(
  typed: string,
  lookup: (name: string) => Promise<string[]> = lookupAll,
): Promise<HomeAddress> {
  const { name, port } = parseAddress(typed);
  if (isIP(name)) {
    if (!isHomeAddress(name)) throw new AddressProblem("refused");
    return { host: name, port };
  }
  let found: string[];
  try {
    found = await lookup(name);
  } catch {
    throw new AddressProblem("unreachable");
  }
  const host = found.find(isHomeAddress);
  if (!host) {
    throw new AddressProblem(found.length === 0 ? "unreachable" : "refused");
  }
  return { host, port };
}

async function lookupAll(name: string) {
  const found = await dnsLookup(name, { all: true });
  return found.map((each) => each.address);
}

/** The address as Settings shows it, and as a URL's host and port. */
export function addressText({ host, port }: HomeAddress) {
  const shown = isIP(host) === 6 ? `[${host}]` : host;
  return `${shown}:${port}`;
}
