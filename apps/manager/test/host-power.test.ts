import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContainerCreateOptions,
  DockerClientLike,
} from "../src/docker.js";
import { createPower } from "../src/host/power.js";
import { createServer } from "../src/server.js";
import { notFound } from "./fake-docker.js";

// Restart and Shut down from Settings → Status: a privileged helper from the
// manager's own image asks the host's systemd, a moment after the manager
// answers, and never during an update.

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.useRealTimers();
});

function docker(
  options: { stale?: boolean; startError?: Error; exitCode?: number } = {},
) {
  const created: ContainerCreateOptions[] = [];
  const events: string[] = [];
  const containers = new Map<string, { Image: string; Labels: object }>([
    [
      "sanctum-manager",
      {
        Image: "sha256:manager",
        Labels: {
          "com.docker.compose.project": "sanctum",
          "com.docker.compose.service": "manager",
        },
      },
    ],
  ]);
  if (options.stale) {
    containers.set("sanctum-power", {
      Image: "sha256:old",
      Labels: { "sanctum.managed": "true", "sanctum.role": "power" },
    });
  }
  const fake = {
    created,
    events,
    createContainer: async (create: ContainerCreateOptions) => {
      created.push(create);
      containers.set(create.name, {
        Image: create.Image,
        Labels: create.Labels ?? {},
      });
      return { id: create.name };
    },
    getContainer: (name: string) => ({
      inspect: async () => {
        const found = containers.get(name);
        if (!found) throw notFound();
        return {
          Id: name,
          Name: `/${name}`,
          Image: found.Image,
          State: { Running: false },
          Config: { Image: found.Image, Labels: found.Labels },
          HostConfig: {},
        };
      },
      start: async () => {
        events.push(`start ${name}`);
        if (options.startError) throw options.startError;
      },
      remove: async () => {
        events.push(`remove ${name}`);
        containers.delete(name);
      },
      rename: async () => undefined,
      stop: async () => undefined,
      update: async () => undefined,
      wait: async (wanted?: { condition?: string }) => {
        events.push(`wait ${name} ${wanted?.condition ?? ""}`.trim());
        return { StatusCode: options.exitCode ?? 0 };
      },
    }),
  };
  return fake as unknown as Pick<typeof fake, "created" | "events"> &
    PowerDocker &
    DockerClientLike;
}

type PowerDocker = Parameters<typeof createPower>[0]["docker"];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("restart and shut down", () => {
  it("makes the helper at once and starts it a moment later", async () => {
    const fake = docker();
    const logs: string[] = [];
    const power = createPower({
      docker: fake,
      busy: async () => false,
      log: (message) => logs.push(message),
      delayMs: 20,
    });
    await power.request("restart");
    expect(fake.created).toEqual([
      {
        name: "sanctum-power",
        Image: "sha256:manager",
        Entrypoint: ["nsenter"],
        Cmd: ["-t", "1", "-m", "-u", "-i", "-n", "--", "systemctl", "reboot"],
        Labels: { "sanctum.managed": "true", "sanctum.role": "power" },
        HostConfig: { Privileged: true, PidMode: "host", AutoRemove: true },
      },
    ]);
    expect(fake.events).toEqual([]);
    expect(power.asked()).toBe("restart");
    await wait(40);
    // Its end is watched before it starts, as it removes itself.
    expect(fake.events).toEqual([
      "wait sanctum-power removed",
      "start sanctum-power",
    ]);
    expect(logs).toEqual(["Restarting the host"]);
  });

  it("shuts down with poweroff, replacing a helper left from before", async () => {
    const fake = docker({ stale: true });
    const power = createPower({
      docker: fake,
      busy: async () => false,
      log: () => undefined,
      delayMs: 0,
    });
    await power.request("shutdown");
    expect(fake.events[0]).toBe("remove sanctum-power");
    expect(fake.created[0]!.Cmd).toContain("poweroff");
  });

  it("refuses during an update, and a second request", async () => {
    const updating = createPower({
      docker: docker(),
      busy: async () => true,
      log: () => undefined,
    });
    await expect(updating.request("restart")).rejects.toThrow(
      "An update is running",
    );

    const power = createPower({
      docker: docker(),
      busy: async () => false,
      log: () => undefined,
      delayMs: 1_000,
    });
    await power.request("restart");
    await expect(power.request("shutdown")).rejects.toThrow(
      "Sanctum is already restarting",
    );
  });

  it("can be asked again at once when systemctl fails, saying why", async () => {
    const logs: string[] = [];
    const power = createPower({
      docker: docker({ exitCode: 1 }),
      busy: async () => false,
      log: (message) => logs.push(message),
      delayMs: 0,
    });
    await power.request("shutdown");
    await wait(10);
    expect(power.asked()).toBeNull();
    expect(logs).toContain(
      "Could not shutdown the host: systemctl ended with 1",
    );
  });

  it("can be asked again once the helper didn't start", async () => {
    const power = createPower({
      docker: docker({ startError: new Error("no such image") }),
      busy: async () => false,
      log: () => undefined,
      delayMs: 0,
    });
    await power.request("restart");
    await wait(10);
    expect(power.asked()).toBeNull();
  });

  it("reserves the request while checking whether an update is running", async () => {
    let finish!: (busy: boolean) => void;
    const fake = docker();
    const power = createPower({
      docker: fake,
      busy: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      log: () => undefined,
      delayMs: 0,
    });
    const first = power.request("restart");
    await expect(power.request("shutdown")).rejects.toThrow(
      "already restarting",
    );
    expect(fake.created).toHaveLength(0);
    finish(false);
    await first;
    expect(fake.created).toHaveLength(1);
  });

  it("allows retrying when the helper starts but the host never goes down", async () => {
    vi.useFakeTimers();
    const power = createPower({
      docker: docker(),
      busy: async () => false,
      log: () => undefined,
      delayMs: 0,
    });
    await power.request("restart");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(power.asked()).toBeNull();
    await power.request("shutdown");
    expect(power.asked()).toBe("shutdown");
  });

  it("refuses updates and cleanup while a power request is pending", async () => {
    let finish!: (busy: boolean) => void;
    const fake = docker();
    const power = createPower({
      docker: fake,
      busy: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      log: () => undefined,
      delayMs: 0,
    });
    const start = vi.fn();
    const free = vi.fn();
    const server = createServer(
      { version: "dev-test" },
      {
        host: {
          docker: fake,
          power,
          updates: { start } as never,
          space: { freeing: () => false, free } as never,
        },
      },
    );
    servers.push(server);
    const pending = power.request("restart");
    for (const url of ["/api/update", "/api/host/space/free"]) {
      expect((await server.inject({ method: "POST", url })).statusCode).toBe(
        409,
      );
    }
    expect(start).not.toHaveBeenCalled();
    expect(free).not.toHaveBeenCalled();
    finish(false);
    await pending;
  });

  it("answers 202 on its routes, 409 when it can't now and 503 without a host", async () => {
    const fake = docker();
    const power = createPower({
      docker: fake,
      busy: async () => false,
      log: () => undefined,
      delayMs: 1_000,
    });
    const server = createServer(
      { version: "dev-test" },
      {
        host: {
          docker: fake,
          updates: {} as never,
          power,
        },
      },
    );
    servers.push(server);
    const restart = await server.inject({
      method: "POST",
      url: "/api/host/restart",
    });
    expect(restart.statusCode).toBe(202);
    expect(restart.json()).toEqual({ action: "restart" });
    const again = await server.inject({
      method: "POST",
      url: "/api/host/shutdown",
    });
    expect(again.statusCode).toBe(409);

    const none = createServer({ version: "dev-test" });
    servers.push(none);
    expect(
      (await none.inject({ method: "POST", url: "/api/host/restart" }))
        .statusCode,
    ).toBe(503);
  });
});
