import { describe, expect, it, vi } from "vitest";

import { createJoining } from "../src/joining.js";

const device = { ieee_address: "0x1", interview_completed: true };

describe("joining events after the device list", () => {
  it("finishes a rejoin even when no further list follows the joined event", async () => {
    const say = vi.fn(async () => {});
    const joining = createJoining(say);
    await joining.listed([device], () => true);
    await joining.event("device_joined", { ieee_address: "0x1" });
    expect(say).toHaveBeenLastCalledWith("0x1", "ready", null);
  });

  it("finishes an interview whose completed list arrived before its events", async () => {
    const say = vi.fn(async () => {});
    const joining = createJoining(say);
    await joining.listed([device], () => false);
    await joining.event("device_interview", {
      ieee_address: "0x1",
      status: "started",
    });
    await joining.event("device_interview", {
      ieee_address: "0x1",
      status: "successful",
    });
    expect(say).toHaveBeenLastCalledWith("0x1", "unsupported", null);
  });
});
