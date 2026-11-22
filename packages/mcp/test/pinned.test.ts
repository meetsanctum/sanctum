import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";

import { PinMismatch, pinnedFetch } from "../src/pinned.js";
import { testCa } from "./certificates.js";

// The connector's requests to a home: over HTTPS only to the computer whose
// chain passes the pin, before anything is written; plain HTTP only to a
// development core on this computer.

async function home(ca: Awaited<ReturnType<typeof testCa>>) {
  const received: { method?: string; url?: string; body: string }[] = [];
  const server = createServer(await ca.serving(), (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ method: request.method, url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ echoed: body, auth: request.headers.authorization }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () => new Promise((resolve) => server.close(() => resolve(undefined))),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `https://127.0.0.1:${port}`, received };
}

describe("a pinned request", () => {
  it("reaches the home whose CA has the pin, and keeps the CA", async () => {
    const ca = await testCa();
    const { url, received } = await home(ca);
    const anchors: unknown[] = [];
    const fetchHome = pinnedFetch({ pin: ca.pin }, (anchor) =>
      anchors.push(anchor),
    );

    const response = await fetchHome(`${url}/api/mcp?x=1`, {
      method: "POST",
      headers: { authorization: "Bearer client_1" },
      body: "hello",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      echoed: "hello",
      auth: "Bearer client_1",
    });
    expect(received).toEqual([
      { method: "POST", url: "/api/mcp?x=1", body: "hello" },
    ]);
    expect(anchors).toEqual([{ pin: ca.pin, caCertificate: ca.pem }]);

    // Again, now checked against the CA it kept.
    expect((await fetchHome(`${url}/again`)).status).toBe(200);
    expect(anchors).toHaveLength(1);
  });

  it("sends nothing to a computer whose CA hasn't the pin", async () => {
    const other = await testCa();
    const ca = await testCa();
    const { url, received } = await home(other);

    await expect(
      pinnedFetch({ pin: ca.pin })(`${url}/api/auth/agents/collect`, {
        method: "POST",
        body: "secret",
      }),
    ).rejects.toBeInstanceOf(PinMismatch);
    // A CA kept from before can't be stood in for either.
    await expect(
      pinnedFetch({
        pin: ca.pin,
        anchor: { pin: ca.pin, caCertificate: ca.pem },
      })(`${url}/x`),
    ).rejects.toBeInstanceOf(PinMismatch);
    expect(received).toEqual([]);
  });

  it("goes over plain HTTP only to this computer, without a pin", async () => {
    const fetchHome = pinnedFetch({ pin: null });
    await expect(
      fetchHome("http://192.168.7.2:3000/api/mcp"),
    ).rejects.toBeInstanceOf(PinMismatch);
    await expect(
      pinnedFetch({ pin: "A".repeat(43) })("http://127.0.0.1:1/api/mcp"),
    ).rejects.toBeInstanceOf(PinMismatch);
  });
});
