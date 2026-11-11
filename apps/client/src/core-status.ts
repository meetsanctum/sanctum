import { coreUrl } from "./core-url";

// Whether the core answers, from its public health check. A core that an
// update just started answers it while it waits for the update to commit,
// and nothing else (`updatePending`), so it counts as updating, not online.
export type CoreStatus =
  | { state: "checking" }
  | { state: "online"; version: string }
  | { state: "updating"; version: string }
  | { state: "offline" };

// How often the core is asked: now and then while it answers, and often
// while it is away, so the screen comes back soon after it does.
const onlineEveryMs = 10_000;
const awayEveryMs = 2_000;

function statusOf(ok: boolean, body: unknown): CoreStatus {
  if (
    ok &&
    typeof body === "object" &&
    body !== null &&
    "service" in body &&
    body.service === "core" &&
    "status" in body &&
    body.status === "ok" &&
    "version" in body &&
    typeof body.version === "string"
  ) {
    return "updatePending" in body && body.updatePending === true
      ? { state: "updating", version: body.version }
      : { state: "online", version: body.version };
  }
  return { state: "offline" };
}

export function startCoreStatusPolling(onStatus: (status: CoreStatus) => void) {
  let isStopped = false;
  let isChecking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const check = async () => {
    clearTimeout(timer);
    isChecking = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 5_000);
    let status: CoreStatus = { state: "offline" };
    try {
      const response = await fetch(coreUrl("/api/health"), {
        signal: controller.signal,
      });
      status = statusOf(response.ok, await response.json());
    } catch {
      // Not answering, or not in time.
    } finally {
      clearTimeout(timeout);
      isChecking = false;
    }
    if (!isStopped) {
      onStatus(status);
      timer = setTimeout(
        check,
        status.state === "online" ? onlineEveryMs : awayEveryMs,
      );
    }
  };

  void check();
  return {
    stop() {
      isStopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
    // Asks at once, when something else suggests the core went away or came
    // back, such as the live connection closing.
    checkNow() {
      if (!isStopped && !isChecking) {
        void check();
      }
    },
  };
}
