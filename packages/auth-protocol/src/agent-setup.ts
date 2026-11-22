// Adding an AI agent: someone starts a one-time setup on one of the home's
// clients and pastes its code into the agent, whose connector checks the
// home before it trades the code's secret for the agent's token. The core
// makes codes and the connector reads them, so both share these rules.

import type { Platform } from "./api.js";
import { isPin } from "./pin.js";

/** A setup runs out this long after it was started, unless it connected. */
export const agentSetupMs = 10 * 60_000;

/**
 * The connector protocols a core accepts: a connector sends its own when it
 * collects a token, and one outside these hears whether Sanctum or the
 * connector needs updating.
 */
export const agentConnectorProtocols = { oldest: 1, newest: 1 } as const;

/**
 * The connector a setup's prompt runs, at the version the prompt pins: the
 * connector's own package version, which its tests hold to this.
 */
export const agentConnector = {
  name: "@meetsanctum/mcp",
  version: "0.1.0",
} as const;

/** The command a setup's prompt runs, which Set it up by hand shows too. */
export function agentSetupCommand(code: string) {
  return `npx -y ${agentConnector.name}@${agentConnector.version} connect ${code}`;
}

/** What a setup's code carries. Nobody types it, so it can be long. */
export type AgentSetupCode = {
  /** The home the connector must find, whatever address it answers on. */
  homeId: string;
  /** The pin of the home's host CA; none over plain HTTP. */
  pin: string | null;
  /** The address the setup was started through, a fallback to discovery. */
  url: string;
  setupId: string;
  /** Only the connector holding this can collect the token. */
  secret: string;
};

const codeScheme = "sanctum:";
const codeVersion = 1;

function toBase64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/** The text a setup's prompt carries after `connect`. */
export function agentSetupCodeText(code: AgentSetupCode) {
  return `${codeScheme}${toBase64Url(
    JSON.stringify({
      v: codeVersion,
      home: code.homeId,
      pin: code.pin,
      url: code.url,
      setup: code.setupId,
      secret: code.secret,
    }),
  )}`;
}

const anId = /^[0-9A-Za-z-]{8,64}$/;
const aSecret = /^[A-Za-z0-9_-]{16,128}$/;

/** What a pasted code holds, or none when it isn't a setup's code. */
export function parseAgentSetupCode(text: string): AgentSetupCode | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(codeScheme)) {
    return null;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(fromBase64Url(trimmed.slice(codeScheme.length)));
  } catch {
    return null;
  }
  const { v, home, pin, url, setup, secret } = body ?? {};
  if (
    v !== codeVersion ||
    typeof home !== "string" ||
    !anId.test(home) ||
    (pin !== null && !isPin(pin)) ||
    typeof url !== "string" ||
    !/^https?:\/\//.test(url) ||
    typeof setup !== "string" ||
    !anId.test(setup) ||
    typeof secret !== "string" ||
    !aSecret.test(secret)
  ) {
    return null;
  }
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { homeId: home, pin, url, setupId: setup, secret };
}

// The routes, under /api/auth/agents.

/** `POST /api/auth/agents/setup`: the name the agent will go by. */
export type StartAgentSetup = { name: string };
export type AgentSetupStarted = {
  setupId: string;
  /** The code for the prompt (see agentSetupCodeText). Shown once. */
  code: string;
  expiresAt: string;
};

/**
 * `GET /api/auth/agents/setup/:id`: where a setup stands. It waits until
 * the agent's first call with its token, which may come after the code is
 * collected; it runs out at `expiresAt` if that hasn't happened, fails after
 * too many wrong secrets, and is cancelled from Settings.
 */
export type AgentSetupStatus =
  | { status: "waiting"; name: string; expiresAt: string }
  | {
      status: "connected";
      agent: { id: string; name: string };
      /** The address the connector connected from. */
      address: string;
      connectedAt: string;
    }
  | { status: "expired" | "failed" | "cancelled"; name: string };

export type CancelAgentSetup = { setupId: string };

/** `POST /api/auth/agents/collect`: the connector trades the secret, once. */
export type CollectAgentToken = {
  setupId: string;
  secret: string;
  platform: Platform;
  /** The connector's protocol (see agentConnectorProtocols). */
  protocol: number;
};
export type AgentTokenCollected = {
  token: string;
  agent: { id: string; name: string };
};

/** `GET /api/auth/agents`: the home's AI agents, for Settings. */
export type AgentInfo = {
  id: string;
  name: string;
  platform: Platform;
  /** Who added it, by the name they have now; none once it's gone. */
  addedBy: { kind: "person" | "client"; id: string; name: string | null };
  createdAt: string;
  lastSeenAt: string | null;
};
