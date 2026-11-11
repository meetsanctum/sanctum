import { isRecord, parseJson, stringValue } from "./values.js";

// Requests to Zigbee2MQTT's bridge (`bridge/request/<name>`) and its answers
// (`bridge/response/<name>`), matched by transaction. Ported from v1's
// zigbee2mqtt-confirmations.ts (Pragmata v1-final), which allowed one
// pending request at a time; a transaction tells each answer apart.

export type BridgeResponse = {
  transaction: string | null;
  ok: boolean;
  error: string;
  data: Record<string, unknown>;
};

/** An answer on `bridge/response/<name>`. */
export function bridgeResponse(payload: Buffer): BridgeResponse {
  const raw = parseJson(payload);
  if (!isRecord(raw)) {
    return {
      transaction: null,
      ok: false,
      error: "Zigbee2MQTT gave an answer that is not JSON",
      data: {},
    };
  }
  const status = stringValue(raw.status)?.toLowerCase() ?? null;
  const ok = !raw.error && (status === null || status === "ok");
  return {
    transaction: stringValue(raw.transaction),
    ok,
    error: ok
      ? ""
      : (stringValue(raw.error) ??
        stringValue(raw.message) ??
        "Zigbee2MQTT refused the request"),
    data: isRecord(raw.data) ? raw.data : {},
  };
}

type Waiting = {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** The requests waiting for Zigbee2MQTT's answer. */
export function createPendingRequests(timeoutMs: number) {
  const waiting = new Map<string, Waiting>();

  return {
    /**
     * Waits for the answer to `transaction`; fails on a refusal or after
     * the timeout, or `ms` for a request that takes longer.
     */
    wait(transaction: string, what: string, ms = timeoutMs) {
      return new Promise<BridgeResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(transaction);
          reject(new Error(`Zigbee2MQTT did not answer: ${what}`));
        }, ms);
        waiting.set(transaction, { resolve, reject, timer });
      });
    },

    /** Settles only the request whose transaction Zigbee2MQTT echoed. */
    answer(response: BridgeResponse) {
      if (!response.transaction) {
        return;
      }
      const request = waiting.get(response.transaction);
      if (!request) {
        return;
      }
      clearTimeout(request.timer);
      waiting.delete(response.transaction);
      if (response.ok) {
        request.resolve(response);
      } else {
        request.reject(new Error(response.error));
      }
    },

    /** Stops waiting for one, as when its request could not be sent. */
    forget(transaction: string) {
      clearTimeout(waiting.get(transaction)?.timer);
      waiting.delete(transaction);
    },

    /** Gives up on every waiting request, as when the driver stops. */
    cancel(reason: string) {
      for (const request of waiting.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(reason));
      }
      waiting.clear();
    },
  };
}
