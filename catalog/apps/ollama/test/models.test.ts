import { describe, expect, it } from "vitest";

import {
  fits,
  hostCheck,
  modelName,
  offeredModels,
  suggestedModel,
} from "../src/models.js";
import { n150Host, piHost } from "./support.js";

// Whether this Sanctum can run a model: by its processor's specs, not by
// which board it is, and by the memory and storage it has free.

const gb = 1_000_000_000;
const model = (id: string) => offeredModels.find((each) => each.id === id)!;

describe("the host check", () => {
  it("calls a processor without the vector instructions likely too slow", () => {
    expect(hostCheck(piHost(), undefined).processor.isLikelySlow).toBe(true);
    expect(hostCheck(n150Host(), undefined).processor.isLikelySlow).toBe(false);
  });

  it("calls one with fewer than four cores likely too slow, and gives one that doesn't say the benefit of the doubt", () => {
    const twoCores = n150Host();
    twoCores.processor.cores = 2;
    const unknown = piHost();
    unknown.processor.matrixInstructions = null;

    expect(hostCheck(twoCores, undefined).processor.isLikelySlow).toBe(true);
    expect(hostCheck(unknown, undefined).processor.isLikelySlow).toBe(false);
  });

  it("gives models what's free, within Ollama's share", () => {
    expect(hostCheck(n150Host(), 8 * gb).memory).toEqual({
      totalBytes: 16 * gb,
      roomBytes: 8 * gb,
    });
    expect(hostCheck(piHost(), 4 * gb).memory?.roomBytes).toBe(4 * gb);
    expect(hostCheck(piHost(), undefined).memory?.roomBytes).toBe(
      3814 * 1024 ** 2,
    );
  });

  it("offers only what fits the memory and storage left", () => {
    const check = hostCheck(piHost(), 4 * gb);
    expect(fits(model("qwen3:4b"), check)).toBe(true);
    expect(fits(model("qwen3:8b"), check)).toBe(false);

    const full = piHost();
    full.storage = { freeBytes: 4 * gb };
    expect(fits(model("qwen3:1.7b"), hostCheck(full, 4 * gb))).toBe(true);
    expect(fits(model("qwen3:4b"), hostCheck(full, 4 * gb))).toBe(false);
  });

  it("needs both readings before it can say a model fits", () => {
    const resources = piHost();
    const offered = model("qwen3:1.7b");
    expect(
      fits(offered, hostCheck({ ...resources, storage: null }, 4 * gb)),
    ).toBe(false);
    expect(
      fits(offered, hostCheck({ ...resources, memory: null }, 4 * gb)),
    ).toBe(false);
  });

  it("suggests Qwen3 1.7B with 8 GB and Qwen3 4B with 16 GB", () => {
    expect(suggestedModel(hostCheck(piHost(), 4 * gb))).toBe("qwen3:1.7b");
    expect(suggestedModel(hostCheck(n150Host(), 8 * gb))).toBe("qwen3:4b");
  });
});

describe("a model's name", () => {
  it("reads as the page offers it, or from its tag", () => {
    expect(modelName("llama3.2:3b")).toBe("Llama 3.2 3B");
    expect(modelName("qwen3:14b")).toBe("Qwen3 14B");
    expect(modelName("mistral:latest")).toBe("Mistral");
    expect(modelName("registry.example:5000/team/custom:7b")).toBe(
      "Registry.example:5000/team/custom 7B",
    );
  });
});
