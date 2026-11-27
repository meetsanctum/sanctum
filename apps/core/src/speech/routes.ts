import type { Hearing } from "@meetsanctum/app-sdk";
import type { FastifyInstance } from "fastify";

import type { Gate } from "../app-host/gate.js";

// GET /api/speech/hearing: how speech recognition is doing for smart
// speakers, in the home's language, for any client that may see the home.
// The Assistant's page reads it, then follows `hearing` on the live socket.
export function registerSpeechRoutes(
  app: FastifyInstance,
  options: { hearing: () => Hearing; gate: Gate },
) {
  app.get("/api/speech/hearing", async (request): Promise<Hearing> => {
    options.gate.admit(request.principal!, { tier: "read" });
    return options.hearing();
  });
}
