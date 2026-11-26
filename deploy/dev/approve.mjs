// `pnpm dev:approve <code>` (deploy/dev/stack.sh): approves a shared
// device's pairing code, as someone would from Settings → Clients. It signs
// in with the seed's login (deploy/dev/seed.mjs), types the code, waits while
// the core checks the device through their exchange, approves it and signs
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
if (new URL(base).protocol !== "http:") {
  console.error("pnpm dev:approve requires a plain-HTTP stack.");
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
  const exchange = await call("/api/auth/pair/lookup", { code }, token);
  // The core gives the device 30 seconds for each of its two steps.
  const until = Date.now() + 75_000;
  let status = await call("/api/auth/pair/exchange", exchange, token);
  while (status.status === "exchanging" && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = await call("/api/auth/pair/exchange", exchange, token);
  }
  if (status.status === "verified") {
    await call("/api/auth/pair/approve", { ...exchange, name }, token);
    console.log(`Approved ${name}.`);
  } else {
    console.error(
      `The device wasn't checked: ${status.reason ?? "it didn't answer"}.`,
    );
    process.exitCode = 1;
  }
} finally {
  try {
    await call("/api/auth/clients/revoke", { id: client.id }, token);
  } catch (error) {
    console.error("Could not sign out the temporary client:", error);
    process.exitCode = 1;
  }
}
