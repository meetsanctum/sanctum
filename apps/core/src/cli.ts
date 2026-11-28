import { formatInviteCode } from "@meetsanctum/auth-protocol";
import { request } from "node:http";
import { createInterface } from "node:readline/promises";

import { localSocketPath } from "./local-access.js";

// A command for the host's shell, for someone who forgot their password and
// has no other way back in: no device signed in as them, no recovery code,
// and no one else at home who signs in. It asks the running core, through
// its local socket, for a code for a new password that works once, for an
// hour, and prints it:
//
//   sudo docker exec -it sanctum-core node dist/cli.js recovery-code
//   sudo docker exec sanctum-core node dist/cli.js recovery-code alex
//
// Without a username it lists who signs in and asks which. The code goes into
// Forgot your password? on the sign-in screen, like any code for a new
// password; the password is still chosen on the person's own device.

const socketPath = localSocketPath(process.env.CORE_DATA_DIR ?? "./data");

function call<T>(method: "GET" | "POST", path: string, json?: unknown) {
  return new Promise<{ status: number; body: T }>((resolve, reject) => {
    const sent = json === undefined ? undefined : JSON.stringify(json);
    const outgoing = request(
      {
        socketPath,
        method,
        path,
        headers: sent ? { "content-type": "application/json" } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    outgoing.on("error", () =>
      reject(
        new Error(
          "Sanctum isn't answering. Check that it's running, then try again.",
        ),
      ),
    );
    outgoing.end(sent);
  });
}

async function choose(people: { name: string; username: string }[]) {
  console.log("Who is the code for?");
  people.forEach((person, index) =>
    console.log(`  ${index + 1}  ${person.name} (${person.username})`),
  );
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await lines.question("Choose a number: ");
    return people[Number(answer.trim()) - 1]?.username;
  } finally {
    lines.close();
  }
}

async function recoveryCode(given: string | undefined) {
  let username = given;
  if (!username) {
    const { body: people } = await call<{ name: string; username: string }[]>(
      "GET",
      "/sign-ins",
    );
    if (people.length === 0) {
      console.error("No one signs in to this home yet.");
      return false;
    }
    username = await choose(people);
    if (!username) {
      console.error("That isn't one of the numbers.");
      return false;
    }
  }
  const { status, body } = await call<
    { code: string; name: string; endsAt: string } | { error: string }
  >("POST", "/recovery-code", { username });
  if ("error" in body) {
    console.error(
      status === 404
        ? `No one signs in as ${username}.`
        : "The code couldn't be made. Try again.",
    );
    return false;
  }
  console.log(
    [
      "",
      `Code for a new password for ${body.name}: ${formatInviteCode(body.code)}`,
      "It works once, for the next hour.",
      "",
      "On your Mac, open Sanctum and choose your home.",
      "Choose Just me, then Forgot your password?, and enter the code.",
    ].join("\n"),
  );
  return true;
}

async function main(command: string | undefined, argument?: string) {
  if (command === "recovery-code") return recoveryCode(argument);
  console.error("Usage: cli.js recovery-code [username]");
  return false;
}

main(process.argv[2], process.argv[3]).then(
  (ok) => process.exit(ok ? 0 : 1),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
