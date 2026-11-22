// What the connector's own command is made of, for the workspace's tests
// to drive against a real core. Only the command is published (`files`).
export {
  connect,
  connectedWords,
  ConnectError,
  connectWords,
  type Connected,
  type ConnectOptions,
} from "./connect.js";
export { PinMismatch, pinnedFetch } from "./pinned.js";
export { serveCommand, type Run } from "./register.js";
export { connectorServer, homeLink, words } from "./serve.js";
export {
  fileTokens,
  listConnections,
  loadConnection,
  saveConnection,
  type Connection,
  type TokenStore,
} from "./store.js";
export { connectorVersion } from "./version.js";
