import type { AppStorage } from "@meetsanctum/app-sdk/storage";
import { AsyncLocalStorage } from "node:async_hooks";

import { withTimeout } from "./errors.js";

// The start context's storage, which the app's handlers of the core's
// events close over (core-events.ts). Each delivery is a call of its own,
// as an action is: AsyncLocalStorage follows it across awaits and the work
// it sets off, so a handler that ran late or left a transaction open
// cannot reach into the start context's call or the next delivery's.
export function createEventStorage(storage: AppStorage, timeoutMs: number) {
  const lifetime = storage.call();
  const active = new AsyncLocalStorage<ReturnType<AppStorage["call"]>>();
  const current = () => active.getStore() ?? lifetime;
  return {
    query: (...args: Parameters<typeof lifetime.query>) =>
      current().query(...args),
    get ended() {
      return lifetime.ended || current().ended;
    },
    end: () => lifetime.end(),
    async run(work: () => void | Promise<void>) {
      const call = storage.call();
      try {
        await active.run(call, () =>
          withTimeout(Promise.resolve().then(work), timeoutMs),
        );
      } finally {
        call.end();
      }
    },
  };
}
