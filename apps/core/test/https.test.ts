import { randomUUID, X509Certificate } from "node:crypto";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  createCoreCertificates,
  type CoreCertificates,
} from "../src/certificate.js";
import { renewCertificate } from "../src/server.js";
import { testCa } from "./certificates.js";
import { claimed, managerSocket, testCore } from "./support.js";

const dayMs = 24 * 60 * 60_000;
const watching: CoreCertificates[] = [];
afterEach(() => {
  for (const certificates of watching.splice(0)) certificates.close();
});

function certificatesFor(
  ca: Awaited<ReturnType<typeof testCa>>,
  clock: { now: number },
) {
  const logs: string[] = [];
  const certificates = createCoreCertificates({
    sign: ca.sign,
    log: (message) => logs.push(message),
    now: () => clock.now,
    checkEveryMs: 5,
  });
  watching.push(certificates);
  return { certificates, logs };
}

describe("the core's certificate", () => {
  it("is for a P-256 key the core keeps in memory, and carries the CA's pin", async () => {
    const clock = { now: Date.parse("2026-10-28T12:00:00Z") };
    const ca = await testCa({ now: () => clock.now });
    const { certificates } = certificatesFor(ca, clock);

    const first = await certificates.first();

    expect(ca.requests).toHaveLength(1);
    expect(ca.requests[0]).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(first.key).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    // The chain: the core's certificate, then the CA's.
    expect(first.cert.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(first.cert).toContain(ca.certificate.trim());
    expect(first.pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Renewed with a third of its 90 days left.
    expect(first.renewAt).toBe(clock.now + 60 * dayMs);
  });

  it("is renewed with a third of its life left, from the same CA", async () => {
    const clock = { now: Date.parse("2026-10-28T12:00:00Z") };
    const ca = await testCa({ now: () => clock.now });
    const { certificates } = certificatesFor(ca, clock);
    const first = await certificates.first();
    const renewed = vi.fn();
    certificates.watch(renewed);

    clock.now += 59 * dayMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(renewed).not.toHaveBeenCalled();

    clock.now += dayMs;
    await vi.waitFor(() => expect(renewed).toHaveBeenCalledTimes(1));
    const next = renewed.mock.calls[0]![0] as typeof first;
    expect(next.pin).toBe(first.pin);
    expect(next.key).not.toBe(first.key);
    expect(certificates.current()).toBe(next);
  });

  it("is replaced at once when a corrected clock is before its start", async () => {
    const clock = { now: Date.parse("2027-10-28T12:00:00Z") };
    const ca = await testCa({ now: () => clock.now });
    const { certificates } = certificatesFor(ca, clock);
    await certificates.first();
    const renewed = vi.fn();
    certificates.watch(renewed);

    // The clock was a year ahead when it was signed.
    clock.now -= 365 * dayMs;

    await vi.waitFor(() => expect(renewed).toHaveBeenCalled());
  });

  it("does not ask again every minute for one dated ahead of its clock", async () => {
    // A clock restarted behind after a power cut: the manager dates from
    // its last signing time, two hours ahead of the host's clock.
    const clock = { now: Date.parse("2026-10-28T12:00:00Z") };
    const ca = await testCa({ now: () => clock.now + 2 * 60 * 60_000 });
    const { certificates } = certificatesFor(ca, clock);
    const first = await certificates.first();
    expect(first.startedAhead).toBe(true);
    const renewed = vi.fn();
    certificates.watch(renewed);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renewed).not.toHaveBeenCalled();
    expect(ca.requests).toHaveLength(1);
  });

  it("keeps serving while a renewal fails, and asks again", async () => {
    const clock = { now: Date.parse("2026-10-28T12:00:00Z") };
    const ca = await testCa({ now: () => clock.now });
    let failing = true;
    const logs: string[] = [];
    const certificates = createCoreCertificates({
      sign: (publicKey) =>
        failing ? Promise.reject(new Error("no manager")) : ca.sign(publicKey),
      log: (message) => logs.push(message),
      now: () => clock.now,
      checkEveryMs: 5,
    });
    watching.push(certificates);
    failing = false;
    const first = await certificates.first();
    failing = true;
    const renewed = vi.fn();
    certificates.watch(renewed);

    clock.now += 61 * dayMs;
    await vi.waitFor(() =>
      expect(logs.some((line) => /could not renew/.test(line))).toBe(true),
    );
    expect(certificates.current()).toBe(first);
    failing = false;
    await vi.waitFor(() => expect(renewed).toHaveBeenCalled());
  });

  it("is refused when it is not for the core's key", async () => {
    const ca = await testCa();
    const other = await testCa();
    const { generateKeyPairSync } = await import("node:crypto");
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    const certificates = createCoreCertificates({
      // A certificate for another key, or signed by another CA.
      sign: async () => ({
        certificate: (await other.sign(stranger)).certificate,
        ca: ca.certificate,
      }),
      log: () => undefined,
    });
    await expect(certificates.first()).rejects.toThrow(/does not fit/);
  });

  it("keeps the served certificate and retries when installing a renewal fails", async () => {
    const clock = { now: Date.parse("2026-10-28T12:00:00Z") };
    const ca = await testCa({ now: () => clock.now });
    const { certificates, logs } = certificatesFor(ca, clock);
    const first = await certificates.first();
    let isFailing = true;
    certificates.watch(() => {
      if (isFailing) throw new Error("Could not install certificate");
    });
    clock.now = first.renewAt;
    await vi.waitFor(() =>
      expect(logs.some((line) => line.includes("could not renew"))).toBe(true),
    );
    expect(certificates.current()).toBe(first);
    isFailing = false;
    await vi.waitFor(() => expect(certificates.current()).not.toBe(first));
  });

  it("is signed by the manager over its socket, once it answers", async () => {
    let ready = false;
    const { client, received } = await managerSocket(() => {
      if (!ready) return { status: 404 };
      return { status: 200, body: { certificate: "…", ca: "…" } };
    });
    const signing = client.signCertificate("-----BEGIN PUBLIC KEY-----");
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(1));
    ready = true;
    expect(await signing).toEqual({ certificate: "…", ca: "…" });
    expect(received[0]).toEqual({
      method: "POST",
      url: "/api/certificate",
      body: { publicKey: "-----BEGIN PUBLIC KEY-----" },
    });
  });
});

// A request to the core over HTTPS that trusts only the test CA, with the
// serial number of the certificate it was served.
function getOverHttps(url: string, ca: string) {
  return new Promise<{ status: number; body: string; serial: string }>(
    (resolve, reject) => {
      const outgoing = request(url, { ca, agent: false }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            serial: (response.socket as TLSSocket).getPeerCertificate()
              .serialNumber,
          }),
        );
      });
      outgoing.on("error", reject);
      outgoing.end();
    },
  );
}

describe("the core over HTTPS", () => {
  it("serves requests and the live WebSocket, and renews without a restart", async () => {
    // The core's clock runs ahead to the renewal; the CA and TLS keep the
    // real one.
    const ca = await testCa({ lifetimeMs: 3 * 60_000 });
    const clock = { now: Date.now() };
    const certificates = createCoreCertificates({
      sign: ca.sign,
      log: () => undefined,
      now: () => clock.now,
      checkEveryMs: 20,
    });
    watching.push(certificates);
    const first = await certificates.first();
    const core = await testCore({ pin: first.pin, https: first });
    const { token } = await claimed(core);
    await core.server.listen({ host: "127.0.0.1", port: 0 });
    const { port } = core.server.server.address() as { port: number };
    const base = `https://127.0.0.1:${port}`;

    const health = await getOverHttps(`${base}/api/health`, ca.certificate);
    expect(health.status).toBe(200);
    const firstSerial = new X509Certificate(first.cert).serialNumber;
    expect(health.serial).toBe(firstSerial);

    // Plain HTTP gets nowhere.
    await expect(
      fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.status),
    ).rejects.toThrow();

    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/live`, {
      ca: ca.certificate,
    });
    const messages: unknown[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token }));
    await vi.waitFor(() => expect(messages).toEqual([{ type: "ready" }]));

    // Two minutes into three: the core asks for a new one and swaps it in.
    clock.now += 2 * 60_000;
    const renewed = new Promise<string>((resolve) =>
      certificates.watch((next) => {
        renewCertificate(core.server, next);
        resolve(new X509Certificate(next.cert).serialNumber);
      }),
    );
    const nextSerial = await renewed;
    expect(nextSerial).not.toBe(firstSerial);

    const after = await getOverHttps(`${base}/api/health`, ca.certificate);
    expect(after.serial).toBe(nextSerial);
    // The open WebSocket carries on through the swap.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const pong = new Promise((resolve) => socket.once("pong", resolve));
    socket.ping(randomUUID());
    await pong;
    socket.terminate();
  });
});
