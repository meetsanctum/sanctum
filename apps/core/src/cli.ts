import { formatInviteCode } from "@meetsanctum/auth-protocol";
import { request } from "node:http";
import { createInterface, type Interface } from "node:readline";

import { localSocketPath } from "./local-access.js";

// A command for the host's shell, for someone who forgot their password and
// has no other way back in: no device signed in as them, no recovery code,
// and no one else at home who signs in. It asks the running core, through
// its local socket, for a code for a new password that works once, for an
// hour, and prints it:
//
//   sudo docker exec -it sanctum-core node dist/cli.js reset-code
//   sudo docker exec sanctum-core node dist/cli.js reset-code YOUR_USERNAME
//
// Without a username it lists who signs in and asks which. The code goes into
// Forgot your password? on the sign-in screen, like any code for a new
// password; the password is still chosen on the person's own device.

const socketPath = localSocketPath(process.env.CORE_DATA_DIR ?? "./data");

type Reply<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: { error: string } };

function call<T>(method: "GET" | "POST", path: string, json?: unknown) {
  return new Promise<Reply<T>>((resolve, reject) => {
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
            const status = response.statusCode ?? 0;
            const body: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            resolve(
              status === 200
                ? { ok: true, body: body as T }
                : { ok: false, status, body: body as { error: string } },
            );
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

function terminalText(value: string) {
  return value.replace(
    /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// One reader for the whole run, which keeps lines typed ahead or piped in
// until a question takes them.
let lines: Interface | undefined;
const waiting: string[] = [];
let answer: ((line: string | undefined) => void) | undefined;
let closed = false;

// One line typed in answer, or nothing once the input closes.
function ask(question: string) {
  lines ??= createInterface({ input: process.stdin })
    .on("line", (line) => {
      if (answer) answer(line);
      else waiting.push(line);
    })
    .once("close", () => {
      closed = true;
      answer?.(undefined);
    });
  process.stdout.write(question);
  const next = waiting.shift();
  if (next !== undefined || closed) return Promise.resolve(next);
  return new Promise<string | undefined>((resolve) => {
    answer = (line) => {
      answer = undefined;
      resolve(line);
    };
  });
}

async function choose(people: { name: string; username: string }[]) {
  console.log("Who is the code for?");
  people.forEach((person, index) =>
    console.log(
      `  ${index + 1}  ${terminalText(person.name)} (${person.username})`,
    ),
  );
  const answer = await ask("Choose a number: ");
  if (answer === undefined) return undefined;
  return people[Number(answer.trim()) - 1]?.username;
}

async function resetCode(given: string | undefined, replace: boolean) {
  let username = given;
  if (!username) {
    const signIns = await call<{ name: string; username: string }[]>(
      "GET",
      "/sign-ins",
    );
    if (!signIns.ok) {
      console.error("Couldn't list who signs in. Try again.");
      return false;
    }
    const people = signIns.body;
    if (people.length === 0) {
      console.error("No one signs in to this home yet.");
      return false;
    }
    username = await choose(people);
    if (!username) {
      console.error("Choose an account from the list to make a code.");
      return false;
    }
  }
  let result = await call<{ code: string; name: string }>(
    "POST",
    "/reset-code",
    { username, replace },
  );
  // Chosen from the list, the question replaces the --replace flag.
  if (!result.ok && result.body.error === "invite_changed" && !given) {
    const answer = await ask(
      "A password code is already active for this account. Make a new one? The previous code will stop working. (y/N) ",
    );
    if (answer?.trim().toLowerCase() === "y") {
      result = await call<{ code: string; name: string }>(
        "POST",
        "/reset-code",
        { username, replace: true },
      );
    } else {
      console.error("No code was made. The previous code still works.");
      return false;
    }
  }
  if (!result.ok) {
    if (result.body.error === "invite_changed") {
      console.error(
        "A password code is already active for this account. Add --replace after the username to make a new code. The previous code will stop working.",
      );
    } else if (result.body.error === "update_pending") {
      console.error("Sanctum is updating. Try again when the update finishes.");
    } else if (result.status === 404 || result.status === 400) {
      console.error(`No one signs in as ${terminalText(username)}.`);
    } else {
      console.error("The code couldn't be made. Try again.");
    }
    return false;
  }
  const { code, name } = result.body;
  console.log(
    [
      "",
      `Code for a new password for ${terminalText(name)}: ${formatInviteCode(code)}`,
      "It works once, for the next hour.",
      "",
      "On your Mac, open Sanctum and choose your home.",
      "Choose Just me, then Forgot your password?, and enter the code.",
    ].join("\n"),
  );
  return true;
}

async function main([command, username, flag, ...extra]: string[]) {
  if (
    command === "reset-code" &&
    !username?.startsWith("--") &&
    (flag === undefined || flag === "--replace") &&
    extra.length === 0
  ) {
    return resetCode(username, flag === "--replace");
  }
  console.error("Usage: cli.js reset-code [username [--replace]]");
  return false;
}

void main(process.argv.slice(2))
  .finally(() => lines?.close())
  .then(
    (ok) => {
      process.exitCode = ok ? 0 : 1;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
