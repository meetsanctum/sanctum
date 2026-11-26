import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { connect, names } from "./agents-support.js";
import { radio, settled } from "./devices-support.js";
import { fakeManager } from "./manager-support.js";
import { loadAppPackage } from "./runner-apps.js";
import { fakePiper } from "./speech-support.js";
import { claimed, fixtureApps, post, testCore } from "./support.js";

it("serves FLAC from the running core after an agent calls announce over MCP", async () => {
  const { server, url: serviceUrl } = await fakePiper([]);
  try {
    const { manager } = fakeManager();
    const hostStatus = await manager.hostStatus();
    manager.serviceUrl = async () => serviceUrl;
    manager.hostStatus = async () => ({
      ...hostStatus,
      network: {
        interface: "lo",
        kind: "other",
        address: "127.0.0.1",
        cidr: "127.0.0.1/32",
        signalDbm: null,
        speedMbps: null,
      },
    });
    manager.wantServiceForCore = vi.fn(async () => {});
    manager.releaseServiceForCore = vi.fn(async () => {});
    radio.reset();
    const lamps = await loadAppPackage(join(fixtureApps, "lamps"), "system");
    const core = await testCore({ manager, apps: [lamps], speakerPort: 0 });
    const person = await claimed(core);
    const { token } = core.auth.clients.createAgent({
      name: "Kitchen agent",
      platform: "macos",
      addedBy: { kind: "person", id: person.person.id },
    });
    const client = await connect(core, token);
    try {
      expect(await names(client)).not.toContain("announce");
      const missing = await client.callTool({
        name: "announce",
        arguments: { speaker: "missing", text: "Dinner is ready." },
      });
      expect(missing.structuredContent).toMatchObject({ error: "not_found" });

      await radio.add("speaker-1", "audio");
      await settled();
      const speaker = core.devices
        .list()
        .find(({ type }) => type === "smart-speaker")!;
      expect(await names(client)).toContain("announce");
      const result = await client.callTool({
        name: "announce",
        arguments: { speaker: speaker.id, text: "Dinner is ready." },
      });
      expect(result.structuredContent).toEqual({
        speaker: speaker.id,
        sentTo: speaker.name,
      });
      expect(manager.wantServiceForCore).toHaveBeenCalledWith(
        "piper",
        expect.anything(),
      );
      const activity = () =>
        core.activity
          .recent()
          .filter((entry) => entry.action === "device.announce");
      expect(activity()).toEqual([]);

      const command = radio.received.at(-1)?.command;
      if (command?.kind !== "audio" || !("announce" in command.command)) {
        throw new Error("The speaker did not receive an announcement");
      }
      const audio = await fetch(command.command.announce.url);
      expect(audio.status).toBe(200);
      expect(audio.headers.get("content-type")).toBe("audio/flac");
      const bytes = Buffer.from(await audio.arrayBuffer());
      expect(bytes.subarray(0, 4).toString()).toBe("fLaC");
      expect(bytes.length).toBeGreaterThan(42);
      expect(activity()).toMatchObject([
        { subjectId: speaker.id, outcome: "ok" },
      ]);
      vi.mocked(manager.releaseServiceForCore).mockClear();
      const switched = await post(
        core,
        "/api/agents/can-use/area",
        {
          id: "devices.announce",
          on: false,
        },
        person,
      );
      expect(switched.statusCode).toBe(200);
      expect(await names(client)).not.toContain("announce");
      expect(manager.releaseServiceForCore).toHaveBeenCalledWith(
        "piper",
        expect.anything(),
      );
    } finally {
      await client.close();
    }
  } finally {
    server.close();
  }
});
