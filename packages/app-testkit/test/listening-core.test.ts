import { expect, it } from "vitest";

import { createListeningCore } from "../src/listening-core.js";

it("settles pending step reads when the driver closes the run", async () => {
  const { calls } = createListeningCore({
    refuse: () => null,
    refuseCall: (error) => {
      throw error;
    },
  });
  const opened = await calls.openListen({ key: "speaker", wakeWord: null });
  if (!opened.accepted) throw new Error(opened.refusal);
  const { run } = opened;
  const first = calls.readListen({ run, after: 0 });
  const second = calls.readListen({ run, after: 0 });

  await calls.closeListen({ run, end: "stopped" });
  await expect(first).resolves.toEqual([{ step: "done" }]);
  await expect(second).resolves.toEqual([{ step: "done" }]);
  await expect(calls.readListen({ run, after: 1 })).resolves.toEqual([]);
});
