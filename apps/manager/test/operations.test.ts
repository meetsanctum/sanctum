import { describe, expect, it } from "vitest";

import {
  createOperations,
  OperationConflictError,
  type Operation,
} from "../src/operations.js";

// The one slot that a core update, and a service's change of image with its time
// under observation, take turns in.

const update: Operation = { kind: "core-update", version: "dev-2" };
const moving: Operation = {
  kind: "service-image",
  service: "zigbee2mqtt",
  to: "zigbee2mqtt:2.14.2",
};

// A journal: what `begin` wrote stays there until the operation has ended.
function journal() {
  let held: Operation | null = null;
  return {
    read: () => held,
    write: (operation: Operation | null) => {
      held = operation;
    },
  };
}

describe("the slot for what can't overlap", () => {
  it("is free when no journal says otherwise", async () => {
    const operations = createOperations();
    operations.heldBy(journal().read);

    expect(await operations.current()).toBeNull();
  });

  it("is held by what a journal says, as a manager finds on starting", async () => {
    const operations = createOperations();
    const updates = journal();
    updates.write(update);
    operations.heldBy(updates.read);

    expect(await operations.current()).toEqual(update);
    await expect(
      operations.claim(moving, async () => "started"),
    ).rejects.toThrow(OperationConflictError);
  });

  it("frees once the journal says it has ended", async () => {
    const operations = createOperations();
    const updates = journal();
    operations.heldBy(updates.read);

    await operations.claim(update, async () => updates.write(update));
    expect(await operations.current()).toEqual(update);

    updates.write(null);

    expect(await operations.current()).toBeNull();
    expect(await operations.claim(moving, async () => "started")).toBe(
      "started",
    );
  });

  it("is held while one is on its way to its journal", async () => {
    const operations = createOperations();
    let wrote!: () => void;
    const writing = new Promise<void>((done) => {
      wrote = done;
    });
    const first = operations.claim(update, () => writing);

    expect(await operations.current()).toEqual(update);
    await expect(
      operations.claim(moving, async () => "started"),
    ).rejects.toThrow("An update is already running");

    wrote();
    await first;
  });

  it("lets only one of two that ask at once begin", async () => {
    const operations = createOperations();
    const begun: string[] = [];

    const asked = await Promise.allSettled([
      operations.claim(update, async () => begun.push("update")),
      operations.claim(moving, async () => begun.push("moving")),
    ]);

    expect(begun).toEqual(["update"]);
    expect(asked.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("frees when what it began fails before writing anything", async () => {
    const operations = createOperations();

    await expect(
      operations.claim(update, async () => {
        throw new Error("The pull failed");
      }),
    ).rejects.toThrow("The pull failed");

    expect(await operations.current()).toBeNull();
  });

  it("can continue its own journal while keeping the slot reserved", async () => {
    const operations = createOperations();
    operations.heldBy(() => moving);

    await operations.claim(
      moving,
      async () => {
        expect(await operations.current()).toEqual(moving);
        await expect(operations.claim(update, async () => {})).rejects.toThrow(
          OperationConflictError,
        );
      },
      { isContinuing: true },
    );
  });

  it("checks other journals even when continuing its own", async () => {
    const operations = createOperations();
    operations.heldBy(() => moving);
    operations.heldBy(() => update);

    await expect(
      operations.claim(moving, async () => {}, { isContinuing: true }),
    ).rejects.toThrow("An update is already running");
  });

  it("does not treat a new start or another service as a continuation", async () => {
    const operations = createOperations();
    operations.heldBy(() => moving);

    await expect(operations.claim(moving, async () => {})).rejects.toThrow(
      OperationConflictError,
    );
    await expect(
      operations.claim({ ...moving, service: "mosquitto" }, async () => {}, {
        isContinuing: true,
      }),
    ).rejects.toThrow(OperationConflictError);
  });

  it("says who holds it", () => {
    expect(new OperationConflictError(update).message).toBe(
      "An update is already running",
    );
    expect(new OperationConflictError(moving).message).toBe(
      "zigbee2mqtt is moving to another version",
    );
  });
});
