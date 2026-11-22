// The versions of the protocol between an app's runner and the core
// (protocol.ts), apart from it, since every app's manifest says which it
// speaks (toStaticManifest in index.ts), and protocol.ts reads index.ts.

/**
 * The runner speaks the version its app's SDK was built for; the core refuses
 * one it doesn't support. A version that only adds calls keeps what the one
 * before says, and the core goes on speaking that one too, so an app that
 * kept running through a core's update goes on with the new core. A version
 * that changes what an earlier one says, as 6 renamed the core's events,
 * raises `oldestProtocolVersion` with it: an app built before is refused and
 * runs again once it's rebuilt.
 */
// 7 lets a driver refuse adding a device whatever it asked (driver.refusals).
// 8 takes a floor wherever a place is taken: a lights place, a workflow's
// motion and light level, and a field declared with names("floor").
// 9 calls an app's uninstall hook as someone removes it.
// 10 lets a driver have a device show itself (driver.identify), and register
// whether it can.
// 11 has a driver say every device's type as it registers it, and the core
// takes it, so a driver built before is refused.
// 12 tells an app when an AI agent's device command is held back by its
// limit a minute, as `limited`.
export const protocolVersion = 12;
/** The oldest version a core still speaks. */
export const oldestProtocolVersion = 11;
