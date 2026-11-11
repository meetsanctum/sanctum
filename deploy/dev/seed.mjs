// `pnpm dev:seed` (deploy/dev/stack.sh): claims a new development home and
// puts its fake lights in rooms. It runs in the core's container, where its
// dependencies are. The login is only ever for a stack, which listens on this
// Mac alone.
import { keyStretching } from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";

const base = process.env.SEED_CORE_URL;
const login = { username: "dev", password: "sanctum-dev-stack" };
const rooms = {
  "Living room": ["Floor lamp", "Shelf light"],
  Office: ["Desk lamp"],
  Bedroom: ["Bedside lamp"],
};

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

// The driver registers its lights as it starts, a moment after the core does.
let devices = [];
const names = Object.values(rooms).flat();
for (let tries = 0; tries < 30; tries++) {
  devices = await call("/api/devices", undefined, token);
  if (names.every((name) => devices.some((each) => each.driverName === name)))
    break;
  await new Promise((done) => setTimeout(done, 500));
}

for (const [room, lights] of Object.entries(rooms)) {
  const { id: roomId } = await call(
    "/api/places/rooms/add",
    { name: room },
    token,
  );
  for (const name of lights) {
    const device = devices.find((each) => each.driverName === name);
    if (!device)
      throw new Error(`${name} didn't appear: is Fake lights running?`);
    await call("/api/devices/update", { id: device.id, name, roomId }, token);
  }
}

console.log(
  `Seeded: ${Object.keys(rooms).length} rooms and ${names.length} fake lights. Sign in as ${login.username}, password ${login.password}.`,
);
