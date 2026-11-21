// `pnpm dev:approve <code>` (deploy/dev/stack.sh): approves a shared
// device's pairing code, as someone would from Settings → Clients. It signs
// in with the seed's login (deploy/dev/seed.mjs), approves the code and signs
// its own client out again. It runs in the core's container, where its
// dependencies are, as the seed does.
import {
  keyStretching,
  normalisePairingCode,
  signInBinding,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";

const base = process.env.SEED_CORE_URL;
const login = { username: "dev", password: "sanctum-dev-stack" };
const code = normalisePairingCode(process.env.APPROVE_CODE ?? "");
const name = process.env.APPROVE_NAME || "Wall display";
if (!code) {
  console.error("Give the code the device shows: pnpm dev:approve ABCD-EFGH");
  process.exit(1);
}

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
  return response.status === 204 ? null : response.json();
}

await opaque.ready;
const { hostId, homeId } = await call("/api/auth/status");
const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
  password: login.password,
});
const started = await call("/api/auth/sign-in/start", {
  username: login.username,
  startLoginRequest,
});
const signedIn = opaque.client.finishLogin({
  clientLoginState,
  loginResponse: started.loginResponse,
  password: login.password,
  keyStretching: keyStretching.profile,
});
if (!signedIn) {
  console.error(
    `Signing in as ${login.username} failed: this home wasn't set up by pnpm dev:seed.`,
  );
  process.exit(1);
}
// Plain HTTP: no certificate authority to bind the sign-in to.
const { token, client } = await call("/api/auth/sign-in/finish", {
  signInId: started.signInId,
  finishLoginRequest: signedIn.finishLoginRequest,
  binding: await signInBinding(signedIn.sessionKey, {
    hostId,
    homeId,
    pin: null,
  }),
  client: { name: "pnpm dev:approve", platform: "macos" },
});
try {
  await call("/api/auth/pair/lookup", { code }, token);
  await call("/api/auth/pair/approve", { code, name }, token);
  console.log(`Approved ${name}.`);
} finally {
  await call("/api/auth/clients/revoke", { id: client.id }, token);
}
