// `pnpm dev:seed` (deploy/dev/stack.sh): claims a new development home and
// puts its sixty fake devices in nine rooms: lights, plugs, contact, motion
// and climate sensors and media players. It runs in the core's container,
// where its dependencies are. The login is only ever for a stack, which
// listens on this Mac alone unless `pnpm dev:display` puts it on the network.
import { keyStretching } from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";

const base = process.env.SEED_CORE_URL;
const login = { username: "dev", password: "sanctum-dev-stack" };
// About the number of devices a real home has, so the client can be timed
// as it would be there; the fake devices app has the same (home.js).
const rooms = {
  "Living room": [
    "Floor lamp",
    "Shelf light",
    "Ceiling light",
    "Reading lamp",
    "Light strip",
    "TV plug",
    "Balcony door",
    "Living room window",
    "Living room motion",
    "Living room climate",
    "Living room box",
  ],
  Kitchen: [
    "Kitchen ceiling",
    "Counter lights",
    "Island pendant",
    "Coffee machine",
    "Dishwasher",
    "Kitchen window",
    "Kitchen motion",
    "Kitchen climate",
  ],
  "Dining room": [
    "Dining pendant",
    "Sideboard lamp",
    "Dining room window",
    "Dining room motion",
    "Dining room climate",
  ],
  Hallway: [
    "Hallway ceiling",
    "Entrance light",
    "Front door",
    "Hallway motion",
    "Hallway climate",
  ],
  Office: [
    "Desk lamp",
    "Office ceiling",
    "Monitor light",
    "Printer",
    "Office window",
    "Office motion",
    "Office climate",
    "Office speaker",
  ],
  Bedroom: [
    "Bedside lamp",
    "Bedroom ceiling",
    "Wardrobe light",
    "Bedroom fan",
    "Bedroom window",
    "Bedroom motion",
    "Bedroom climate",
  ],
  "Kids' room": [
    "Kids' ceiling",
    "Night light",
    "Star projector",
    "Kids' room window",
    "Kids' room motion",
    "Kids' room climate",
  ],
  Bathroom: [
    "Mirror light",
    "Bathroom ceiling",
    "Bathroom window",
    "Bathroom motion",
    "Bathroom climate",
  ],
  Garden: [
    "Garden lights",
    "Terrace lights",
    "Fountain pump",
    "Garden gate",
    "Garden motion",
  ],
};
// What the household shows its contact sensors as.
const shownAs = Object.fromEntries(
  Object.values(rooms)
    .flat()
    .filter((name) => / (door|window|gate)$/.test(name))
    .map((name) => [name, name.endsWith("window") ? "window" : "door"]),
);

async function call(path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const { claimed } = await call("/api/auth/status");
if (claimed) {
  console.log(
    `This home is already claimed. Sign in as ${login.username} if this set it up, or start again with pnpm dev:down.`,
  );
  process.exit(0);
}

await opaque.ready;
const { clientRegistrationState, registrationRequest } =
  opaque.client.startRegistration({ password: login.password });
const { registrationId, registrationResponse } = await call(
  "/api/auth/claim/start",
  { username: login.username, registrationRequest },
);
const { registrationRecord } = opaque.client.finishRegistration({
  clientRegistrationState,
  registrationResponse,
  password: login.password,
  keyStretching: keyStretching.profile,
});
const { token } = await call("/api/auth/claim/finish", {
  registrationId,
  registrationRecord,
  keyStretching: keyStretching.version,
  person: { name: "Dev", colour: "#c5cdac" },
  client: { name: "pnpm dev:seed", platform: "macos" },
});

// The driver registers its devices as it starts, a moment after the core does.
let devices = [];
const names = Object.values(rooms).flat();
for (let tries = 0; tries < 30; tries++) {
  devices = await call("/api/devices", undefined, token);
  if (names.every((name) => devices.some((each) => each.driverName === name)))
    break;
  await new Promise((done) => setTimeout(done, 500));
}

for (const [room, deviceNames] of Object.entries(rooms)) {
  const { id: roomId } = await call(
    "/api/places/rooms/add",
    { name: room },
    token,
  );
  for (const name of deviceNames) {
    const device = devices.find((each) => each.driverName === name);
    if (!device)
      throw new Error(`${name} didn't appear: is Fake lights running?`);
    await call(
      "/api/devices/update",
      { id: device.id, name, roomId, shownAs: shownAs[name] },
      token,
    );
  }
}

console.log(
  `Seeded: ${Object.keys(rooms).length} rooms and ${names.length} fake devices. Sign in as ${login.username}, password ${login.password}.`,
);
