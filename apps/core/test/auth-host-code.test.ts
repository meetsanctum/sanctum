import { keyStretching } from "@meetsanctum/auth-protocol";
import { eq } from "drizzle-orm";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activity } from "../src/activity/schema.js";
import { createLocalAccess, type LocalAccess } from "../src/local-access.js";
import { checkInvite, invite, redeem } from "./invite-support.js";
import { claimed, maya, signIn, testCore } from "./support.js";

// A code for a new password made on the host itself, for someone with no
// other way back in: a reset that works once, for an hour, which Activity
// says Sanctum made. The host's command reaches it through a socket only
// the core's own container can open.

describe("a code made on the host", () => {
  it("chooses a new password once, within the hour, and says Sanctum made it", async () => {
    const core = await testCore();
    const claim = await claimed(core);

    const made = await core.auth.invites.makeOnHost(maya.username);

    expect(made.name).toBe(claim.person.name);
    const used = await redeem(core, made.code, {
      username: maya.username,
      password: "a new password",
      stretching: keyStretching.profile,
    });
    expect(used.outcome).toBe("joined");
    expect((await signIn(core, { password: "a new password" })).outcome).toBe(
      "signed-in",
    );
    expect(
      core.db
        .select()
        .from(activity)
        .where(eq(activity.action, "invite.create"))
        .all(),
    ).toEqual([
      expect.objectContaining({
        actor: "sanctum",
        reason: "reset",
        subjectId: claim.person.id,
      }),
    ]);
  });

  it("accepts the code until the one-hour expiry", async () => {
    const core = await testCore();
    await claimed(core);
    const made = await core.auth.invites.makeOnHost(maya.username);
    const options = { stretching: keyStretching.profile };
    core.advance(60 * 60_000 - 1);
    expect((await checkInvite(core, made.code, options)).outcome).toBe(
      "checked",
    );

    core.advance(1);
    const checked = await checkInvite(core, made.code, options);
    expect(checked.outcome).toBe("refused");
    if (checked.outcome !== "refused") throw new Error("Expected a refusal");
    expect(checked.response.statusCode).toBe(410);
    expect(checked.response.json()).toEqual({ error: "invite_ended" });
  });

  it("requires consent to replace an active reset and leaves the recovery code", async () => {
    const core = await testCore();
    const claim = await claimed(core);
    const recovery = await invite(
      core,
      claim.token,
      claim.person.id,
      "recovery",
    );
    const reset = await invite(core, claim.token, claim.person.id, "reset");

    await expect(
      core.auth.invites.makeOnHost(maya.username),
    ).rejects.toMatchObject({
      code: "invite_changed",
    });
    expect((await checkInvite(core, reset.code!)).outcome).toBe("checked");

    await core.auth.invites.makeOnHost(maya.username, true);

    expect(
      (
        await redeem(core, reset.code!, {
          username: maya.username,
          password: "from the old reset",
        })
      ).outcome,
    ).not.toBe("joined");
    expect(
      (
        await redeem(core, recovery.code!, {
          username: maya.username,
          password: "from the recovery code",
        })
      ).outcome,
    ).toBe("joined");
  });

  it("is refused for someone who doesn't sign in", async () => {
    const core = await testCore();
    await claimed(core);

    await expect(core.auth.invites.makeOnHost("nobody")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists who signs in, by name", async () => {
    const core = await testCore();
    const claim = await claimed(core);

    expect(core.auth.invites.signIns()).toEqual([
      { name: claim.person.name, username: maya.username },
    ]);
  });
});

describe("the local socket", () => {
  let folder: string | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  async function open(access: LocalAccess) {
    // Short, as macOS caps a socket's path at about 104 characters.
    folder = await mkdtemp(join(tmpdir(), "sl-"));
    const path = join(folder, "core.sock");
    const local = createLocalAccess(path, access, () => {});
    await local.listen();
    close = () => local.close();
    return path;
  }

  function call(path: string, method: string, url: string, json?: unknown) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const outgoing = request(
        { socketPath: path, method, path: url },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(json === undefined ? undefined : JSON.stringify(json));
    });
  }

  it("is open to this container's user only, and answers the command", async () => {
    const makeCode = vi.fn<LocalAccess["makeCode"]>().mockResolvedValue({
      code: "K7QXM4PD",
      name: "for maya",
      endsAt: "2026-11-28T12:00:00Z",
    });
    const path = await open({
      signIns: () => [{ name: "Maya Keller", username: "maya" }],
      updatePending: () => false,
      makeCode,
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await call(path, "GET", "/sign-ins")).toEqual({
      status: 200,
      body: [{ name: "Maya Keller", username: "maya" }],
    });
    expect(
      await call(path, "POST", "/reset-code", { username: "maya" }),
    ).toEqual({
      status: 200,
      body: {
        code: "K7QXM4PD",
        name: "for maya",
        endsAt: "2026-11-28T12:00:00Z",
      },
    });
    expect(makeCode).toHaveBeenCalledWith("maya", false);
    expect(await call(path, "POST", "/reset-code", { name: 1 })).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect(
      await call(path, "POST", "/reset-code", {
        username: "maya",
        replace: "yes",
      }),
    ).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(makeCode).toHaveBeenCalledOnce();
    expect(
      await call(path, "POST", "/reset-code", {
        username: "maya",
        replace: true,
      }),
    ).toMatchObject({ status: 200 });
    expect(makeCode).toHaveBeenLastCalledWith("maya", true);
  });

  it("refuses to issue a code until the update commits", async () => {
    let onTrial = true;
    const makeCode = vi.fn<LocalAccess["makeCode"]>().mockResolvedValue({
      code: "K7QXM4PD",
      name: "Example",
      endsAt: "2026-11-28T12:00:00Z",
    });
    const path = await open({
      signIns: () => [],
      updatePending: () => onTrial,
      makeCode,
    });

    expect(
      await call(path, "POST", "/reset-code", { username: "example" }),
    ).toEqual({
      status: 503,
      body: { error: "update_pending" },
    });
    expect(makeCode).not.toHaveBeenCalled();

    onTrial = false;
    expect(
      await call(path, "POST", "/reset-code", { username: "example" }),
    ).toMatchObject({
      status: 200,
    });
    expect(makeCode).toHaveBeenCalledOnce();
  });
});
