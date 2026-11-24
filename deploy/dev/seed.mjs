// `pnpm dev:seed` (deploy/dev/stack.sh): claims a new development home and
// puts its sixty fake devices in nine rooms: lights, plugs, contact, motion
// and climate sensors and media players. It runs in the core's container,
// where its dependencies are. The login is only ever for a stack, which
// listens on this Mac alone unless `pnpm dev:display` puts it on the network.
import { keyStretching } from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";

const base = process.env.SEED_CORE_URL;
const login = { username: "dev", password: "sanctum-dev-stack" };
const rooms = JSON.parse(process.env.SEED_ROOMS);
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
let devices = new Map();
const names = Object.values(rooms).flat();
for (let tries = 0; tries < 30; tries++) {
  const available = await call("/api/devices", undefined, token);
  devices = new Map(
    available
      .filter((device) => device.driver === "sanctum.fake-lights")
      .map((device) => [device.driverName, device]),
  );
  if (names.every((name) => devices.has(name))) break;
  await new Promise((done) => setTimeout(done, 500));
}

const missing = names.filter((name) => !devices.has(name));
if (missing.length)
  throw new Error(`Fake lights did not register: ${missing.join(", ")}`);

for (const [room, deviceNames] of Object.entries(rooms)) {
  const { id: roomId } = await call(
    "/api/places/rooms/add",
    { name: room },
    token,
  );
  for (const name of deviceNames) {
    await call(
      "/api/devices/update",
      {
        id: devices.get(name).id,
        name: name.replace(/(^| )\p{L}/gu, (letter) => letter.toUpperCase()),
        roomId,
        shownAs: shownAs[name],
      },
      token,
    );
  }
}

console.log(
  `Seeded: ${Object.keys(rooms).length} rooms and ${names.length} fake devices. Sign in as ${login.username}, password ${login.password}.`,
);
