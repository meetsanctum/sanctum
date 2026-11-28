import { describe, expect, it } from "vitest";

import { connect } from "./agents-support.js";
import { claimed, post, testCore, type TestCore } from "./support.js";

const driver = "sanctum.example";

async function speakerHome() {
  const core = await testCore();
  const maya = await claimed(core);
  const { id: speaker } = core.devices.register(driver, {
    key: "speaker",
    name: "Office Speaker",
    type: "smart-speaker",
    capabilities: [
      { id: "audio", kind: "audio", features: { listens: true } },
      { id: "button", kind: "button", features: { actions: ["single"] } },
    ],
  });
  const agent = core.auth.clients.createAgent({
    name: "Office agent",
    platform: "macos",
    addedBy: { kind: "person", id: maya.person.id },
  });
  const client = await connect(core, agent.token);
  const area = (id: string, on: boolean) =>
    post(core, "/api/agents/can-use/area", { id, on }, { token: maya.token });
  return { core, client, area, speaker };
}

async function readActivity(
  client: Awaited<ReturnType<typeof connect>>,
  input: Record<string, unknown>,
) {
  const result = await client.callTool({ name: "activity", arguments: input });
  return {
    isError: result.isError === true,
    content: result.structuredContent as Record<string, unknown>,
  };
}

function recordSpeakerRequest(
  core: TestCore,
  speaker: string,
  heardWordsMs: number,
  reason?: "not_understood",
) {
  return core.activity.for("devices")({
    action: "device.request",
    outcome: "ok",
    reason,
    subjectId: speaker,
    actor: `speaker:${speaker}`,
    detail: { capability: "audio", capabilityKind: "audio", heardWordsMs },
  });
}

describe("speaker activity for AI agents", () => {
  it("omits timing entries for unrecognised speech across agent Activity pages", async () => {
    const { core, client, area, speaker } = await speakerHome();
    await area("activity.read", true);
    await area("devices.read:audio", true);
    recordSpeakerRequest(core, speaker, 100);
    recordSpeakerRequest(core, speaker, 200, "not_understood");
    const latest = recordSpeakerRequest(core, speaker, 300);
    recordSpeakerRequest(core, speaker, 400, "not_understood");

    const first = await readActivity(client, { device: speaker, limit: 1 });
    expect(first).toMatchObject({
      isError: false,
      content: {
        entries: [
          {
            action: "device.request",
            reason: null,
            detail: { heardWordsMs: 300 },
          },
        ],
        next: latest,
      },
    });
    expect(
      await readActivity(client, {
        device: speaker,
        limit: 1,
        before: first.content.next,
      }),
    ).toMatchObject({
      isError: false,
      content: {
        entries: [
          {
            action: "device.request",
            reason: null,
            detail: { heardWordsMs: 100 },
          },
        ],
        next: null,
      },
    });
    const householdPage = core.activity.page({
      subjectId: speaker,
      kind: "devices",
      limit: 10,
    });
    expect(householdPage.entries.map((entry) => entry.reason)).toEqual([
      "not_understood",
      null,
      "not_understood",
      null,
    ]);
  });

  it("groups repeated speaker button presses across an unrecognised speech entry", async () => {
    const { core, client, area, speaker } = await speakerHome();
    await area("activity.read", true);
    await area("devices.read:button", true);
    await area("devices.read:audio", false);
    const press = () =>
      core.presses.press(driver, {
        key: "speaker",
        capability: "button",
        action: "single",
      });
    press();
    core.advance(500);
    recordSpeakerRequest(core, speaker, 200, "not_understood");
    core.advance(500);
    press();

    expect(await readActivity(client, { device: speaker })).toMatchObject({
      isError: false,
      content: { entries: [{ action: "device.press", count: 2 }], next: null },
    });
  });
});
