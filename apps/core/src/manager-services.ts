import type { z } from "zod";

import {
  heldServices,
  serviceGrant,
  serviceStatus,
} from "./manager-answers.js";

function servicePath(service: string, app: string) {
  return `/api/services/${encodeURIComponent(service)}/apps/${encodeURIComponent(app)}`;
}

type Response = { status: number; body: string };
type Request = (
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<Response>;

export function createManagerServices(options: {
  call: Request;
  once: (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ) => Promise<string>;
  ask: <T>(attempt: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  expectGranted: (response: Response) => void;
  parseBody: <T extends z.ZodType>(schema: T, body: string) => z.output<T>;
}) {
  const { call, once, ask, expectGranted, parseBody } = options;
  return {
    // Where a service answers over HTTP while it runs, as Ollama does, or
    // null while it doesn't.
    async serviceUrl(service: string) {
      const answer = parseBody(
        serviceStatus,
        await once(
          "GET",
          `/api/services/${encodeURIComponent(service)}`,
          undefined,
          5_000,
        ),
      );
      return answer.service.url ?? null;
    },

    // The core wants a service for itself, as Piper for the speech it makes:
    // the manager runs it from now on, and serviceUrl gives where it answers
    // once it runs. Asking again changes nothing.
    // A superseded request stops retrying, but its current write must settle
    // before speech sends the replacement.
    async wantServiceForCore(
      service: string,
      { signal }: { signal?: AbortSignal } = {},
    ) {
      await ask(async () => {
        const response = await call(
          "PUT",
          `/api/services/${encodeURIComponent(service)}/core`,
        );
        expectGranted(response);
      }, signal);
    },

    // The core no longer wants the service, which then stops once nothing
    // else needs it; its data stays. The manager answers once its reconcile
    // has run, which may wait for the service's container to stop.
    async releaseServiceForCore(
      service: string,
      { signal }: { signal?: AbortSignal } = {},
    ) {
      await ask(async () => {
        const response = await call(
          "DELETE",
          `/api/services/${encodeURIComponent(service)}/core`,
          undefined,
          30_000,
        );
        expectGranted(response);
      }, signal);
    },

    // Erases a service's own data, once no app needs it and it has stopped.
    async eraseServiceData(service: string) {
      await once(
        "DELETE",
        `/api/services/${encodeURIComponent(service)}/data`,
        undefined,
        60_000,
      );
    },

    // An app needs a service: the manager runs it from now on and answers
    // with the app's connection details. Asking again changes nothing.
    async needService(service: string, app: string) {
      return ask(async () => {
        const response = await call("PUT", servicePath(service, app));
        expectGranted(response);
        return parseBody(serviceGrant, response.body).connection;
      });
    },

    // The services the manager keeps for the app, whatever this core asked for.
    async servicesHeldBy(
      app: string,
      { signal }: { signal?: AbortSignal } = {},
    ) {
      return ask(async () => {
        const response = await call(
          "GET",
          "/api/services",
          undefined,
          undefined,
          signal,
        );
        expectGranted(response);
        return parseBody(heldServices, response.body)
          .services.filter(({ apps }) => apps.includes(app))
          .map(({ name }) => name);
      }, signal);
    },

    // The app's permission for the service was switched off: one call,
    // which the manager answers once the app's broker account is out of the
    // broker, so a person sees it off only when it is. Rejects when the
    // manager does not confirm in time.
    async revokeService(service: string, app: string) {
      await once("DELETE", servicePath(service, app), undefined, 30_000);
    },

    // The app no longer needs the service. Once no app does, the manager
    // stops it; its data stays. The manager answers once its reconcile has
    // run, which may wait for a service's container to stop, so this waits
    // as long as revokeService does.
    async releaseService(
      service: string,
      app: string,
      { signal }: { signal?: AbortSignal } = {},
    ) {
      await ask(async () => {
        const response = await call(
          "DELETE",
          servicePath(service, app),
          undefined,
          30_000,
          signal,
        );
        expectGranted(response);
      }, signal);
    },
  };
}
