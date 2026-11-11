import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AppHost } from "../app-host/host.js";
import { placesForPage } from "../app-host/page-requests.js";
import { changedBy, parseRequest } from "../auth/callers.js";
import type { Devices } from "../devices/devices.js";
import type { Entities } from "../entities/entities.js";
import type { Workflows } from "../workflows/workflows.js";
import {
  floorChanges,
  homeChanges,
  newFloor,
  newRoom,
  newZone,
  removal,
  roomChanges,
  zoneChanges,
  type PlacesModule,
} from "./places.js";
import { roomRemoval } from "./room-removal.js";

// Places' client routes. Every client reads and changes the home, shared
// clients too, since rooms are household things. Like Auth's routes they use
// GET and POST only.
//
//   GET  /api/places                      { home, floors, rooms, zones }
//   GET  /api/places/home                 { name, timeZone, coordinates:
//                                         { latitude, longitude,
//                                         elevation } }
//   POST /api/places/home/update          { name?, timeZone?, coordinates? };
//                                         null takes one away, and
//                                         coordinates need a time zone;
//                                         their elevation is optional
//   POST /api/places/home/suggest-location
//                                         { latitude, longitude, elevation,
//                                         timeZone, place } from the public
//                                         IP address
//   POST /api/places/floors/add           { name, level? }
//   POST /api/places/floors/update        { id, name?, level? }
//   POST /api/places/floors/remove        { id }
//   POST /api/places/rooms/add            { name, floorId? }
//   POST /api/places/rooms/update         { id, name?, floorId? }
//   GET  /api/places/rooms/removal?id=<id>
//                                         RoomRemoval: what removing it
//                                         takes with it
//   POST /api/places/rooms/remove         { id }
//   POST /api/places/zones/add            { name, roomIds? }
//   POST /api/places/zones/update         { id, name?, roomIds? }
//   POST /api/places/zones/remove         { id }

export function registerPlacesRoutes(
  app: FastifyInstance,
  options: {
    places: PlacesModule;
    // What removing a room takes with it (room-removal.ts).
    devices: Devices;
    entities: Entities;
    apps: AppHost;
    workflows: Workflows;
  },
) {
  const { places } = options;
  const by = (request: FastifyRequest) => changedBy(request.principal!);

  app.get("/api/places", async (request) => {
    placesForPage(request);
    return places.list();
  });

  app.get("/api/places/home", async () => places.home());

  app.post("/api/places/home/update", async (request) =>
    places.updateHome(by(request), parseRequest(homeChanges, request.body)),
  );
  app.post("/api/places/home/suggest-location", async (request) =>
    places.suggestLocation(by(request)),
  );

  app.post("/api/places/floors/add", async (request) =>
    places.addFloor(by(request), parseRequest(newFloor, request.body)),
  );
  app.post("/api/places/floors/update", async (request) =>
    places.updateFloor(by(request), parseRequest(floorChanges, request.body)),
  );
  app.post("/api/places/floors/remove", async (request, reply) => {
    places.removeFloor(by(request), parseRequest(removal, request.body));
    return reply.code(204).send();
  });

  app.post("/api/places/rooms/add", async (request) =>
    places.addRoom(by(request), parseRequest(newRoom, request.body)),
  );
  app.post("/api/places/rooms/update", async (request) =>
    places.updateRoom(by(request), parseRequest(roomChanges, request.body)),
  );
  app.get("/api/places/rooms/removal", async (request) =>
    roomRemoval(options, parseRequest(removal, request.query).id),
  );
  app.post("/api/places/rooms/remove", async (request, reply) => {
    places.removeRoom(by(request), parseRequest(removal, request.body));
    return reply.code(204).send();
  });

  app.post("/api/places/zones/add", async (request) =>
    places.addZone(by(request), parseRequest(newZone, request.body)),
  );
  app.post("/api/places/zones/update", async (request) =>
    places.updateZone(by(request), parseRequest(zoneChanges, request.body)),
  );
  app.post("/api/places/zones/remove", async (request, reply) => {
    places.removeZone(by(request), parseRequest(removal, request.body));
    return reply.code(204).send();
  });
}
