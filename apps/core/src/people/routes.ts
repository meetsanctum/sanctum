import type {
  AddPerson,
  ChangePerson,
  PersonInfo,
  RemovePerson,
} from "@meetsanctum/auth-protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { changedBy, parseRequest } from "../auth/callers.js";
import type { LiveConnections } from "../auth/live.js";
import { personInfo } from "../auth/logins.js";
import { newPerson, personChanges, type People } from "./people.js";

// People's routes. Every client lists the household and adds, changes and
// removes people, shared clients too: names, avatars and colours are how the
// apps show who did what. A claimed host always keeps someone who can sign
// in.
//
//   GET  /api/people           PersonInfo[]
//   POST /api/people/add       AddPerson → PersonInfo
//   POST /api/people/update    ChangePerson → PersonInfo
//   POST /api/people/remove    RemovePerson → 204

const id = z.string().min(1).max(64);

const schemas = {
  add: newPerson satisfies z.ZodType<unknown, AddPerson>,
  update: personChanges.extend({ id }) satisfies z.ZodType<
    unknown,
    ChangePerson
  >,
  remove: z.object({ id }) satisfies z.ZodType<RemovePerson>,
};

export function registerPeopleRoutes(
  app: FastifyInstance,
  options: {
    people: People;
    // Removing someone closes the live connections their clients had open.
    connections: Pick<LiveConnections, "closePerson">;
  },
) {
  const { people, connections } = options;
  const by = (request: FastifyRequest) => changedBy(request.principal!);

  app.get("/api/people", async (): Promise<PersonInfo[]> =>
    people.list().map(personInfo),
  );

  app.post("/api/people/add", async (request): Promise<PersonInfo> => {
    return personInfo(
      people.add(parseRequest(schemas.add, request.body), by(request)),
    );
  });

  app.post("/api/people/update", async (request): Promise<PersonInfo> => {
    const { id: personId, ...changes } = parseRequest(
      schemas.update,
      request.body,
    );
    return personInfo(people.update(personId, changes, by(request)));
  });

  // Their login and personal clients go with them, so their next request is
  // refused; their open connections close now.
  app.post("/api/people/remove", async (request, reply) => {
    const { id: personId } = parseRequest(schemas.remove, request.body);
    people.remove(personId, by(request));
    connections.closePerson(personId);
    return reply.code(204).send();
  });
}
