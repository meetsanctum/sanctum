import { permissionInfo, type Sighting } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledApp } from "../src/app-host/installed.js";
import { createLanPolicies } from "../src/app-host/lan.js";
import type { LanVersion } from "../src/manager-answers.js";
import { ManagerRefusal, ManagerUnavailable } from "../src/manager.js";

const service = "discover:mdns:_example._tcp";
const otherService = "discover:mdns:_other._tcp";
const port = "lan:tcp:6053";
const kitchen: Sighting = {
  service: "_example._tcp",
  name: "kitchen",
  host: "kitchen.local",
  addresses: ["192.168.1.40"],
  port: 6053,
  txt: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setUp() {
  const entry = {
    app: { id: "sanctum.example" },
    manifest: {
      permissions: [
        { id: service, needed: true },
        { id: otherService },
        { id: port, needed: true },
      ],
    },
    granted: [service, otherService, port],
    off: false,
  } as unknown as InstalledApp;
  let sightings = [kitchen];
  const apply = vi.fn(async (_app: string, policy: LanVersion) => policy);
  const policies = createLanPolicies({
    core: "core",
    manager: { applyLanPolicy: apply },
    installed: new Map([[entry.app.id, entry]]),
    sightings: () => sightings,
    onReach: vi.fn(),
    log: vi.fn(),
    againMs: 100,
  });
  const initial = policies.starting(entry)!;
  policies.started(entry, initial, {
    core: initial.core,
    count: initial.count,
    manager: "manager",
    holder: "holder-1",
  });
  return {
    entry,
    policies,
    apply,
    setSightings(next: Sighting[]) {
      sightings = next;
      policies.sync();
    },
  };
}

describe("confirming an app's network policies", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    new ManagerRefusal("Invalid policy", 400),
    new ManagerRefusal("The manager's answer was not understood"),
  ])(
    "keeps a permission on after an unconfirmed refusal: %s",
    async (error) => {
      vi.useFakeTimers();
      const { entry, policies, apply } = setUp();
      apply.mockRejectedValue(error);

      await expect(policies.taking(entry, port)).rejects.toBe(error);

      expect([...policies.reachable(entry)!]).toEqual(kitchen.addresses);
      policies.close();
    },
  );

  it("takes in a restarted manager's run for the same holder, and names it next", async () => {
    const { entry, policies, apply, setSightings } = setUp();
    apply.mockImplementationOnce(async (_app, policy) => ({
      ...policy,
      manager: "manager-again",
    }));

    setSightings([{ ...kitchen, addresses: ["192.168.1.41"] }]);
    await vi.waitFor(() =>
      expect([...policies.reachable(entry)!]).toEqual(["192.168.1.41"]),
    );
    setSightings([{ ...kitchen, addresses: ["192.168.1.42"] }]);

    await vi.waitFor(() =>
      expect(apply.mock.calls.at(-1)![1]).toMatchObject({
        manager: "manager-again",
        holder: "holder-1",
        addresses: ["192.168.1.42"],
      }),
    );
    policies.close();
  });

  it.each(["core", "count", "holder"] as const)(
    "rejects a confirmation for a different %s and waits before retrying",
    async (field) => {
      vi.useFakeTimers();
      const { entry, policies, apply } = setUp();
      const pending = deferred<LanVersion>();
      apply.mockImplementationOnce(async (_app, policy) => ({
        ...policy,
        [field]: field === "count" ? policy.count + 1 : "different",
      }));
      apply.mockImplementation(() => pending.promise);

      const taking = policies.taking(entry, port);
      const rejected = expect(taking).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(apply).toHaveBeenCalledTimes(1);
      await rejected;
      await vi.advanceTimersByTimeAsync(100);
      expect(apply).toHaveBeenCalledTimes(2);
      policies.close();
    },
  );

  it.each(["confirmed", "refused", "unavailable"])(
    "ignores a %s reply from the holder before a restart",
    async (answer) => {
      vi.useFakeTimers();
      const { entry, policies, apply, setSightings } = setUp();
      const pending = deferred<LanVersion>();
      apply.mockImplementationOnce(() => pending.promise);
      setSightings([{ ...kitchen, addresses: ["192.168.1.41"] }]);
      const old = apply.mock.calls[0]![1];
      setSightings([{ ...kitchen, addresses: ["192.168.1.42"] }]);
      const starting = policies.starting(entry)!;
      policies.started(entry, starting, {
        core: starting.core,
        count: starting.count,
        manager: "manager",
        holder: "holder-2",
      });

      if (answer === "confirmed") pending.resolve(old);
      else if (answer === "refused") {
        pending.reject(new ManagerRefusal("Holder gone", 409));
      } else pending.reject(new ManagerUnavailable("No answer"));
      await vi.advanceTimersByTimeAsync(0);

      expect([...policies.reachable(entry)!]).toEqual(["192.168.1.42"]);
      expect(vi.getTimerCount()).toBe(0);
      expect(apply).toHaveBeenCalledTimes(1);
      policies.close();
    },
  );

  it("confirms a narrower policy even if a timed out request may have widened it", async () => {
    vi.useFakeTimers();
    const { entry, policies, apply, setSightings } = setUp();
    apply.mockRejectedValueOnce(new ManagerUnavailable("No answer"));
    setSightings([
      kitchen,
      { ...kitchen, service: "_other._tcp", addresses: ["192.168.1.41"] },
    ]);
    await vi.advanceTimersByTimeAsync(0);

    const taking = policies.taking(entry, otherService);
    expect(taking).toBeInstanceOf(Promise);
    await vi.advanceTimersByTimeAsync(100);
    await taking;
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]![1]).toMatchObject({
      addresses: kitchen.addresses,
      ports: [6053],
    });
    policies.close();
  });

  it("settles a revocation against current sightings when they change during a request", async () => {
    vi.useFakeTimers();
    const { entry, policies, apply, setSightings } = setUp();
    // The port is optional here, so taking it leaves the other port reachable.
    entry.manifest.permissions = [
      { id: service, reason: "For the test.", needed: true },
      { id: port, reason: "For the test." },
      { id: "lan:tcp:8080", reason: "For the test." },
    ].map(permissionInfo);
    entry.granted.push("lan:tcp:8080");
    const pending = deferred<LanVersion>();
    apply.mockImplementationOnce(() => pending.promise);
    policies.sync();
    const taking = policies.taking(entry, port);
    let isTaken = false;
    void taking?.then(() => (isTaken = true));
    setSightings([{ ...kitchen, addresses: ["192.168.1.41"] }]);

    pending.resolve(apply.mock.calls[0]![1]);
    await vi.advanceTimersByTimeAsync(0);

    expect(apply.mock.calls.at(-1)![1]).toMatchObject({
      addresses: ["192.168.1.41"],
      ports: [8080],
    });
    expect(isTaken).toBe(true);
    policies.close();
  });

  it("keeps revocation blocked after a start whose policy may have loaded without an answer", async () => {
    vi.useFakeTimers();
    const { entry, policies } = setUp();
    const starting = policies.starting(entry)!;
    policies.started(entry, starting, undefined);

    await expect(policies.taking(entry, port)).rejects.toThrow();

    policies.close();
  });

  it("sends a range as [from, to], and takes it away when it's switched off", async () => {
    vi.useFakeTimers();
    const { entry, policies, apply } = setUp();
    const range = "lan:tcp:49152-65535";
    entry.manifest.permissions = [
      { id: service, reason: "For the test.", needed: true },
      { id: port, reason: "For the test.", needed: true },
      { id: range, reason: "For the test." },
    ].map(permissionInfo);
    entry.granted.push(range);
    policies.sync();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls.at(-1)![1]).toMatchObject({
      ports: [6053, [49_152, 65_535]],
    });

    const pending = deferred<LanVersion>();
    apply.mockImplementationOnce(() => pending.promise);
    const taking = policies.taking(entry, range);
    let isTaken = false;
    void taking?.then(() => (isTaken = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls.at(-1)![1]).toMatchObject({ ports: [6053] });
    // Off only once the manager has confirmed the rules without it.
    expect(isTaken).toBe(false);

    pending.resolve(apply.mock.calls.at(-1)![1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(isTaken).toBe(true);
    policies.close();
  });

  it("sends the ports of an app that names single ones as it always has", async () => {
    vi.useFakeTimers();
    const { entry, policies, apply } = setUp();
    entry.manifest.permissions = [
      { id: service, reason: "For the test.", needed: true },
      { id: port, reason: "For the test.", needed: true },
      { id: "lan:tcp:6054", reason: "For the test." },
    ].map(permissionInfo);
    entry.granted.push("lan:tcp:6054");
    policies.sync();
    await vi.advanceTimersByTimeAsync(0);

    // Two ports side by side stay two ports, as a manager without ranges
    // takes them.
    expect(apply.mock.calls.at(-1)![1]).toMatchObject({ ports: [6053, 6054] });
    policies.close();
  });
});
