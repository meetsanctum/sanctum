import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { InvalidPublicKey, type HostAuthority } from "./host-ca.js";

// The core asks the manager to sign the public key it made in memory: on every
// start, and again when a third of its certificate's life is left. Only the
// core mounts the socket, and only a public key comes in: the CA's key never
// leaves the manager.

const signBody = z.object({ publicKey: z.string().min(1).max(4_096) });

export function registerCertificateRoutes(
  app: FastifyInstance,
  authority: HostAuthority | undefined,
  clock: () => Promise<boolean | null>,
) {
  // Whether the host's clock is synchronised (clock.ts), for Settings to warn
  // while it isn't: certificates are dated by it.
  app.get("/api/clock", async () => ({ synchronised: await clock() }));

  app.post("/api/certificate", async (request, reply) => {
    if (!authority) {
      return reply.code(503).send({ error: "This manager has no host CA" });
    }
    const body = signBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid certificate request" });
    }
    try {
      return await authority.sign(body.data.publicKey);
    } catch (error) {
      if (error instanceof InvalidPublicKey) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // The CA certificate, public, for people checking the host from its shell
  // (cli.js ca) and tools such as curl.
  app.get("/api/certificate/ca", async (_request, reply) => {
    if (!authority) {
      return reply.code(503).send({ error: "This manager has no host CA" });
    }
    return { certificate: authority.certificate() };
  });
}
