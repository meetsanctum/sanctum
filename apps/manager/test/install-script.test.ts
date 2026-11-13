import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installation, removeInstallations } from "./install-script-support.js";

afterEach(removeInstallations);

describe("host installer", () => {
  it("refuses another installation before changing host settings", async () => {
    const host = await installation();

    await expect(
      host.run([], { INSTALL_TEST_MANAGER: "running" }),
    ).rejects.toThrow("set up another way");

    expect(await host.changes()).toBe("");
  });

  it("checks the existing manager belongs to its compose file", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.run([], {
        INSTALL_TEST_MANAGER: "running",
        INSTALL_TEST_COMPOSE: "/another/compose.yml",
      }),
    ).rejects.toThrow("set up another way");

    expect(await host.changes()).toBe("");
  });

  it("refuses a channel change before changing host settings", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.run(["--channel", "stable"], { INSTALL_TEST_MANAGER: "running" }),
    ).rejects.toThrow("does not change it");

    expect(await host.changes()).toBe("");
  });

  it("leaves a running manager alone", async () => {
    const host = await installation();
    await host.save();

    await host.run([], { INSTALL_TEST_MANAGER: "running" });

    const commands = (await host.commands()).map(({ args }) => args);
    expect(commands.some(([command]) => command === "pull")).toBe(false);
    expect(commands).not.toContainEqual(["start", "sanctum-manager"]);
    expect(commands.some((args) => args.includes("up"))).toBe(false);
  });

  it("starts a stopped manager without recreating its updated image", async () => {
    const host = await installation();
    await host.save();

    await host.run([], { INSTALL_TEST_MANAGER: "stopped" });

    const commands = (await host.commands()).map(({ args }) => args);
    expect(commands).toContainEqual(["start", "sanctum-manager"]);
    expect(commands.some((args) => args.includes("up"))).toBe(false);
  });

  it("preserves the channel and publisher when resuming an interrupted install", async () => {
    const host = await installation();
    await host.save("edge", "sanctum-example");

    await host.run();

    expect((await host.commands()).map(({ args }) => args)).toContainEqual([
      "pull",
      "ghcr.io/sanctum-example/sanctum-manager:edge",
    ]);
    expect(await host.settings()).toContain(
      "SANCTUM_IMAGE_OWNER=sanctum-example",
    );
  });

  it("refuses a channel change when an interrupted install has no manager yet", async () => {
    const host = await installation();
    await host.save();

    await expect(host.run(["--channel", "stable"])).rejects.toThrow(
      "does not change it",
    );

    expect(await host.changes()).toBe("");
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("starts only the selected manager image despite shell and working directory settings", async () => {
    const host = await installation();
    await writeFile(join(host.dir, "../.env"), "SANCTUM_CHANNEL=edge\n");

    await host.run(["--channel", "stable"], {
      SANCTUM_CHANNEL: "edge",
      SANCTUM_MANAGER_IMAGE: "sanctum.example/other:edge",
      COMPOSE_PROJECT_NAME: "another-project",
      COMPOSE_PROFILES: "dev",
    });

    const command = (await host.commands()).find(({ args }) =>
      args.includes("up"),
    )!;
    expect(command.channel).toBe("stable");
    expect(command.image).toBe("ghcr.io/meetsanctum/sanctum-manager:stable");
    expect(command.args).toEqual([
      "compose",
      "--project-name",
      "sanctum",
      "--env-file",
      join(host.dir, ".env"),
      "-f",
      join(host.dir, "compose.yml"),
      "up",
      "-d",
      "manager",
    ]);
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=stable");
  });

  it("keeps settings after a failed start so the same install can resume", async () => {
    const host = await installation();

    await expect(
      host.run(["--channel", "edge"], { INSTALL_TEST_FAIL_START: "1" }),
    ).rejects.toThrow();
    await host.run();

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("counts health check time toward the 15 minute startup deadline", async () => {
    const host = await installation();

    const result = await host
      .runShell(
        `running() { SECONDS=$((SECONDS + 500)); return 1; }
sleep() { :; }
wait_until_running`,
        [],
      )
      .catch((error: { stdout: string; stderr: string }) => error);

    expect(result.stderr).toContain("did not start within 15 minutes");
    expect(result.stdout.split(".").length).toBeLessThan(5);
  });
});
