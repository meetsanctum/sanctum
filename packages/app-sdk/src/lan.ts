// Reaching devices on the home's network. An app never has the network to
// itself: one that holds lan:tcp:<port> gets a network of its own whose rules
// let it open connections only to the addresses found for it (discovery.ts),
// on that port, and nothing else, not the internet, the host or other
// containers. It hears of an address only once its rules let it through, and
// one taken away is shut before Sanctum says so.

const lanPrefix = "lan:tcp:";

/** The permission to reach the devices an app found, on one TCP port. */
export const lanPermission = (port: number) => `${lanPrefix}${port}`;

/** The port a lan:tcp: permission names, or null for any other permission. */
export function lanPort(permission: string) {
  if (!permission.startsWith(lanPrefix)) return null;
  const port = permission.slice(lanPrefix.length);
  if (!/^[1-9][0-9]{0,4}$/.test(port)) return null;
  const number = Number(port);
  return number <= 65_535 ? number : null;
}

/** Whether a permission id is a lan: one that names no port it can. */
export const isMalformedLan = (permission: string) =>
  permission.startsWith("lan:") && lanPort(permission) === null;

/** The ports a set of permissions lets an app reach its devices on, in order. */
export const lanPorts = (permissions: readonly string[]) =>
  [...new Set(permissions.flatMap((each) => lanPort(each) ?? []))].sort(
    (a, b) => a - b,
  );
