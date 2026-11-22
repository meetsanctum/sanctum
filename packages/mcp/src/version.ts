import manifest from "../package.json" with { type: "json" };

// The connector's version, which an agent's registration pins, and the
// protocol it speaks with a home's setup (auth-protocol), fixed when it's
// built.

export const connectorVersion = manifest.version;
export const connectorProtocol = 1;
