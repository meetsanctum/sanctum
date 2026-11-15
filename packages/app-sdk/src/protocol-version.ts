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
export const protocolVersion = 6;
/** The oldest version a core still speaks. */
export const oldestProtocolVersion = 6;
