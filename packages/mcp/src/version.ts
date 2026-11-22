import { agentConnectorProtocols } from "@meetsanctum/auth-protocol";

// The connector's version, which an agent's registration pins, and the
// protocol it speaks with a home's setup (auth-protocol), fixed when it's
// built.

export const connectorVersion = "0.1.0";
export const connectorProtocol: number = agentConnectorProtocols.newest;
