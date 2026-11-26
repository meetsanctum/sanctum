import { describe, expect, it } from "vitest";

import {
  listenAhead,
  maxListenChunkBytes,
  openVoiceRun,
  type ListenCalls,
  type ListenStep,
  type VoiceRun,
} from "../src/index.js";

// A core whose answers a test releases by hand.
function fakeCore(opened: Awaited<ReturnType<ListenCalls["openListen"]>>) {
  const sent: { audio: Buffer; answer: () => void; fail: () => void }[] = [];
  const closed: string[] = [];
  const steps: ListenStep[][] = [];
  const core: ListenCalls = {
    openListen: async () => opened,
    sendListen: ({ audio }) =>
      new Promise((resolve, reject) =>
        sent.push({
          audio: Buffer.from(audio, "base64"),
          answer: resolve,
          fail: () => reject(new Error("ended")),
        }),
      ),
    readListen: async ({ after }) => steps[after] ?? [],
    closeListen: async ({ end }) => {
      closed.push(end);
    },
  };
  return { core, sent, closed, steps };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function opened() {
  const fake = fakeCore({ accepted: true, run: "run-12345678" });
  const run = (await openVoiceRun(fake.core, {
    key: "speaker",
    wakeWord: "Okay Nabu",
  })) as VoiceRun;
  return { ...fake, run };
}

describe("a voice run", () => {
  it("hands a refusal back as it came", async () => {
    const fake = fakeCore({ accepted: false, refusal: "off" });
    await expect(
      openVoiceRun(fake.core, { key: "speaker", wakeWord: null }),
    ).resolves.toEqual({ accepted: false, refusal: "off" });
  });

  it("sends at most a few chunks before the core answers, in order", async () => {
    const { run, sent } = await opened();
    for (let i = 0; i < listenAhead + 3; i += 1) {
      run.send(new Uint8Array(1000).fill(i));
    }
    await settle();
    expect(sent).toHaveLength(listenAhead);
    sent[0]!.answer();
    await settle();
    expect(sent).toHaveLength(listenAhead + 1);
    expect(sent.map((each) => each.audio[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("splits sound larger than one call can carry", async () => {
    const { run, sent } = await opened();
    run.send(new Uint8Array(maxListenChunkBytes * 2 + 10));
    await settle();
    expect(sent.map((each) => each.audio.byteLength)).toEqual([
      maxListenChunkBytes,
      maxListenChunkBytes,
      10,
    ]);
  });

  it("ends as behind once over two seconds of sound wait", async () => {
    const { run, closed, sent } = await opened();
    // 0.1 s chunks, none answered: five go, the rest wait.
    for (let i = 0; i < 26; i += 1) run.send(new Uint8Array(3_200));
    await settle();
    expect(closed).toEqual(["behind"]);
    run.send(new Uint8Array(3_200));
    await settle();
    expect(sent).toHaveLength(listenAhead);
  });

  it("stops sending once the core ends the run", async () => {
    const { run, sent } = await opened();
    run.send(new Uint8Array(10));
    await settle();
    sent[0]!.fail();
    await settle();
    run.send(new Uint8Array(10));
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("reads its steps in order until done", async () => {
    const { run, steps } = await opened();
    steps[0] = [{ step: "stopped" }, { step: "heard", text: "lights off" }];
    steps[2] = [{ step: "done" }];
    const seen: string[] = [];
    for await (const step of run.steps()) seen.push(step.step);
    expect(seen).toEqual(["stopped", "heard", "done"]);
  });

  it("closes once", async () => {
    const { run, closed } = await opened();
    await run.close("stopped");
    await run.close("done");
    expect(closed).toEqual(["stopped"]);
  });
});
