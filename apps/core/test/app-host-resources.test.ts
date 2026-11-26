import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fakeManager, piStatus } from "./manager-support.js";
import { claimed, post, testCore } from "./support.js";

// ctx.host.resources(): what the host has, from what the manager reports for
// Settings → System, so an app can tell whether something fits before it
// starts it. It needs no permission: nothing in it names the home.

const app = defineApp({
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [],
  actions: [
    defineAction({
      id: "example.host",
      title: "Host",
      tier: "read",
      input: z.object({}),
      output: z.unknown(),
      run: (ctx) => ctx.host.resources(),
    }),
  ],
  events: [],
});

async function asked(manager = fakeManager().manager) {
  const core = await testCore({
    apps: [{ app, origin: "third-party" }],
    manager,
  });
  const maya = await claimed(core);
  return (
    await post(core, "/api/apps/sanctum.example/actions/example.host", {}, maya)
  ).json();
}

describe("what an app reads of the host", () => {
  it("is its board or processor, its cores and vector instructions, and the memory and storage free", async () => {
    const { manager } = fakeManager();
    manager.hostStatus = async () => {
      const status = piStatus();
      return {
        ...status,
        processor: { ...status.processor, matrixInstructions: false },
      };
    };

    expect(await asked(manager)).toEqual({
      processor: {
        name: "Raspberry Pi 4 Model B",
        cores: 4,
        matrixInstructions: false,
      },
      memory: { totalBytes: 8_199_577_600, availableBytes: 7_542_419_456 },
      storage: { freeBytes: 6_917_287_936 },
    });
  });

  it("names an x86 host's processor, and leaves unknown what an older manager doesn't say", async () => {
    const { manager } = fakeManager();
    manager.hostStatus = async () => ({
      ...piStatus(),
      model: null,
      processor: { ...piStatus().processor, name: "Intel(R) N150" },
    });

    expect(await asked(manager)).toMatchObject({
      processor: { name: "Intel(R) N150", matrixInstructions: null },
    });
  });
});
