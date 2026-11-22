import { describe, expect, it } from "vitest";

import { agentSetupCodeText, parseAgentSetupCode } from "../src/index.js";

const code = {
  homeId: "3f6d1c2a-8e1b-4d6f-9a51-1d1d1f6e6e73",
  pin: "A".repeat(43),
  url: "https://192.168.7.2:8443",
  setupId: "8b0d3c1e-5a2f-4c7e-8d3b-6f1e2a9c0b47",
  secret: "s".repeat(43),
};

function encoded(body: unknown) {
  return `sanctum:${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
}

describe("an AI agent's setup code", () => {
  it("reads back what it carries", () => {
    const text = agentSetupCodeText(code);

    expect(text).toMatch(/^sanctum:[A-Za-z0-9_-]+$/);
    expect(parseAgentSetupCode(text)).toEqual(code);
    expect(parseAgentSetupCode(`  ${text}\n`)).toEqual(code);
    expect(
      parseAgentSetupCode(agentSetupCodeText({ ...code, pin: null })),
    ).toEqual({ ...code, pin: null });
  });

  it("isn't read when it's something else", () => {
    const body = {
      v: 1,
      home: code.homeId,
      pin: code.pin,
      url: code.url,
      setup: code.setupId,
      secret: code.secret,
    };

    expect(parseAgentSetupCode(encoded(body))).toEqual(code);
    for (const text of [
      "",
      "sanctum-pair:?v=2",
      "sanctum:",
      "sanctum:not base64!",
      encoded("a string"),
      encoded({ ...body, v: 2 }),
      encoded({ ...body, pin: "short" }),
      encoded({ ...body, url: "ftp://192.168.7.2" }),
      encoded({ ...body, url: "https://" }),
      encoded({ ...body, home: "a b" }),
      encoded({ ...body, secret: "too-short" }),
      encoded({ ...body, setup: undefined }),
    ]) {
      expect(parseAgentSetupCode(text), text).toBeNull();
    }
  });
});
