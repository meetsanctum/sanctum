import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createManagerClient } from "../src/manager.js";

it("reads the manager's audit even when a service reports a long error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sanctum-audit-client-"));
  const socketPath = join(dir, "manager.sock");
  const reason =
    "Could not pull the service image: " + "registry failure ".repeat(50);
  const audit = {
    audit: "manager-audit",
    entries: [
      {
        n: 1,
        at: new Date().toISOString(),
        action: "service.fail",
        outcome: "failed",
        reason,
      },
    ],
  };
  const server = createServer((_request, response) =>
    response.end(JSON.stringify(audit)),
  );
  const client = createManagerClient({
    socketPath,
    homeId: "home",
    log: () => undefined,
  });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    expect(await client.audit(0)).toEqual(audit);
  } finally {
    client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
