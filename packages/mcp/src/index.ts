// What the connector's own command is made of, for the workspace's tests
// to drive against a real core. Only the command is published (`files`).
export {
  connect,
  connectedWords,
  ConnectError,
  connectWords,
  type ConnectOptions,
} from "./connect.js";
export { connectorServer, homeLink, words } from "./serve.js";
export {
  fileTokens,
  listConnections,
  loadConnection,
  saveConnection,
} from "./store.js";
