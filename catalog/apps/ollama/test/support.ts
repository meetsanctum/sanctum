import {
  createAppContext,
  permissionIds,
  type AppDefinition,
  type CoreCalls,
  type HostResources,
} from "@meetsanctum/app-sdk";

// A core and an Ollama for the Ollama app's tests: the manager's connection
// to Ollama, what the host has, and Ollama's API as it answers, with a
// download that goes on until the test lets it finish.

const gb = 1_000_000_000;

export const piHost = (): HostResources => ({
  processor: {
    name: "Raspberry Pi 4 Model B",
    cores: 4,
    matrixInstructions: false,
  },
  memory: { totalBytes: 8 * gb, availableBytes: 5.1 * gb },
  storage: { freeBytes: 41 * gb },
});

export const n150Host = (): HostResources => ({
  processor: { name: "Intel(R) N150", cores: 4, matrixInstructions: true },
  memory: { totalBytes: 16 * gb, availableBytes: 9.8 * gb },
  storage: { freeBytes: 180 * gb },
});

type Pulling = {
  model: string;
  aborted: boolean;
  // Sends a line of Ollama's progress.
  send: (line: object) => void;
  finish: () => void;
};

export function fakeOllama() {
  const ollama = {
    isUp: true,
    models: [] as { name: string; size: number; remote_host?: string }[],
    pulls: [] as Pulling[],
    deleted: [] as string[],
  };
  const encoder = new TextEncoder();
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    if (!ollama.isUp) throw new TypeError("fetch failed");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (url.pathname === "/api/tags") return json({ models: ollama.models });
    if (url.pathname === "/api/delete") {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      if (!ollama.models.some((each) => each.name === model)) {
        return json({ error: `model '${model}' not found` }, 404);
      }
      ollama.models = ollama.models.filter((each) => each.name !== model);
      ollama.deleted.push(model);
      return json({});
    }
    if (url.pathname === "/api/pull") {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start: (each) => void (controller = each),
      });
      const pulling: Pulling = {
        model,
        aborted: false,
        send: (line) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
        finish: () => {
          pulling.send({ status: "success" });
          ollama.models.push({ name: model, size: 1.4 * gb });
          controller.close();
        },
      };
      init?.signal?.addEventListener("abort", () => {
        pulling.aborted = true;
        controller.error(init.signal!.reason);
      });
      ollama.pulls.push(pulling);
      return new Response(body);
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { ollama, fetcher };
}

/** A context for the app's code, as the core gives it to an action. */
export function fakeContext(
  app: AppDefinition,
  options: { host?: () => HostResources } = {},
) {
  const logs: string[] = [];
  const absent = async (): Promise<never> => {
    throw new Error("Ollama does not use this call");
  };
  const core = {
    query: absent,
    serviceConnection: async (name: string) => {
      if (name !== "ollama") throw new Error(`No service ${name}`);
      return {
        http: { url: "http://sanctum-ollama:11434" },
        memoryBytes: 8 * 1024 ** 3,
      };
    },
    permissions: async () => permissionIds(app.permissions),
    hostResources: async () => (options.host ?? n150Host)(),
    log: (message: string) => void logs.push(message),
  } as Partial<CoreCalls>;
  const calls = new Proxy(core, {
    get: (target, key) => target[key as keyof CoreCalls] ?? absent,
  }) as CoreCalls;
  const ctx = createAppContext({
    appId: app.id,
    actor: { kind: "user", id: "maya" },
    core: calls,
    app,
  });
  return { ctx, logs };
}

/** Runs one of the app's actions as a person would. */
export async function run(
  app: AppDefinition,
  ctx: ReturnType<typeof fakeContext>["ctx"],
  id: string,
  input: unknown = {},
) {
  const action = app.actions.find((each) => each.id === id)!;
  return action.run(ctx, action.input.parse(input)) as Promise<unknown>;
}
