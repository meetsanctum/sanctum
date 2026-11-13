import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  installation,
  removeInstallations,
  type Command,
  type Docker,
} from "./install-script-support.js";

afterEach(removeInstallations);

// A home that runs: the manager from Compose, what it made, and beside it a
// development stack's on the same Docker.
const home: Docker = {
  containers: [
    { name: "sanctum-manager", image: "manager-image", compose: true },
    { name: "sanctum-manager-updater", image: "manager-image" },
    { name: "sanctum-core", image: "core-image" },
    { name: "sanctum-app-sanctum.example", image: "node-image" },
    { name: "sanctum-mosquitto", image: "mosquitto-image" },
    { name: "sanctum-tree-core", image: "stack-core-image", stack: "tree" },
  ],
  volumes: [
    { name: "sanctum-manager-data", compose: true },
    { name: "sanctum-core-data" },
    { name: "sanctum-app-data-sanctum.example" },
    { name: "sanctum-tree-core-data", stack: "tree" },
  ],
  networks: [{ name: "sanctum" }, { name: "sanctum-tree", stack: "tree" }],
  images: [
    { id: "manager-image" },
    { id: "core-image" },
    { id: "previous-core-image" },
    { id: "stack-core-image", stack: "tree" },
  ],
  usedElsewhere: ["node-image"],
};

// What changes the machine: everything but questions.
function changing(commands: Command[]) {
  return commands
    .filter(
      ({ tool, args }) =>
        tool === "systemctl" ||
        (tool === "losetup" && args[0] === "-d") ||
        (!tool &&
          (["stop", "rm"].includes(args[0]!) ||
            (["volume", "network", "image"].includes(args[0]!) &&
              args[1] === "rm"))),
    )
    .map(({ tool, args }) => [tool ?? "docker", ...args].join(" "));
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

// A removal asks the stand-in Docker some forty questions, each a process of
// its own, which takes a slow machine longer than a test's five seconds.
describe("host installer, removing", { timeout: 30_000 }, () => {
  it("removes what Sanctum made, in order, and nothing of a development stack", async () => {
    const host = await installation();
    await host.save("stable");
    await writeFile(join(host.imagesFolder, "sanctum.example.img"), "");
    await writeFile(join(host.imagesFolder, "sanctum.weather.img"), "");

    const { stdout } = await host.uninstall(home, {
      answer: "remove",
      env: { INSTALL_TEST_ATTACHED: "sanctum.example.img" },
    });

    expect(stdout).toContain("your home's data");
    expect(stdout).toContain("Sanctum is removed");
    expect(changing(await host.commands())).toEqual([
      "docker stop sanctum-manager-updater",
      "docker stop sanctum-manager",
      "docker rm -f -v sanctum-manager-updater sanctum-core sanctum-app-sanctum.example sanctum-mosquitto sanctum-manager",
      "losetup -d /dev/loop7",
      "docker volume rm sanctum-core-data sanctum-app-data-sanctum.example sanctum-manager-data",
      "docker network rm sanctum",
      "docker image rm -f core-image",
      "docker image rm -f manager-image",
      "docker image rm -f mosquitto-image",
      "docker image rm -f previous-core-image",
    ]);
    expect(await exists(host.dir)).toBe(false);
  });

  it("asks only about the images in Sanctum's own volume", async () => {
    const host = await installation();
    await host.save();
    await writeFile(join(host.imagesFolder, "sanctum.example.img"), "");

    await host.uninstall(home, { answer: "remove" });

    const asked = (await host.commands()).filter(
      ({ tool }) => tool === "losetup",
    );
    expect(asked.map(({ args }) => args)).toEqual([
      [
        "-j",
        join(host.imagesFolder, "sanctum.example.img"),
        "-n",
        "-O",
        "NAME",
      ],
    ]);
  });

  it("leaves everything when the answer is anything but remove", async () => {
    const host = await installation();
    await host.save();

    await expect(host.uninstall(home, { answer: "yes" })).rejects.toThrow(
      "Sanctum stays. Nothing was changed.",
    );

    expect(changing(await host.commands())).toEqual([]);
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("refuses without a terminal to ask on", async () => {
    const host = await installation();
    await host.save();

    await expect(host.uninstall(home)).rejects.toThrow("add --yes");

    expect(changing(await host.commands())).toEqual([]);
  });

  it("removes without asking when told to", async () => {
    const host = await installation();
    await host.save();

    const { stdout } = await host.uninstall(home, { args: ["--yes"] });

    expect(stdout).toContain("with your home's data");
    expect(stdout).not.toContain("Type");
    expect(changing(await host.commands())).toContain(
      "docker network rm sanctum",
    );
    expect(await exists(host.dir)).toBe(false);
  });

  it("refuses a manager set up another way", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_COMPOSE: "/another/compose.yml" },
      }),
    ).rejects.toThrow("set up another way");

    expect(changing(await host.commands())).toEqual([]);
  });

  it("does not bypass ownership checks when finding the manager fails", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_FAIL_MANAGER_LOOKUP: "1" },
      }),
    ).rejects.toThrow("Manager lookup failed");

    expect(changing(await host.commands())).toEqual([]);
    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it("refuses what a manager left behind with no installation of its own", async () => {
    const host = await installation();

    await expect(
      host.uninstall(
        { volumes: [{ name: "sanctum-core-data" }] },
        { args: ["--yes"] },
      ),
    ).rejects.toThrow("set up another way");

    expect(changing(await host.commands())).toEqual([]);
  });

  it("refuses a home on the dev channel", async () => {
    const host = await installation();
    await host.save("dev");

    await expect(host.uninstall(home, { args: ["--yes"] })).rejects.toThrow(
      "on the dev channel",
    );

    expect(changing(await host.commands())).toEqual([]);
  });

  it("says so where there is no Sanctum, beside a development stack's", async () => {
    const host = await installation();

    const { stdout } = await host.uninstall({
      containers: [
        { name: "sanctum-tree-core", image: "stack-core-image", stack: "tree" },
      ],
      volumes: [{ name: "sanctum-tree-core-data", stack: "tree" }],
    });

    expect(stdout).toContain("Sanctum is not installed on this machine");
    expect(changing(await host.commands())).toEqual([]);
  });

  it("finishes a removal that was cut short", async () => {
    const host = await installation();
    await host.save();

    await host.uninstall(
      { volumes: [{ name: "sanctum-manager-data", compose: true }] },
      { answer: "remove" },
    );

    expect(changing(await host.commands())).toEqual([
      "docker volume rm sanctum-manager-data",
    ]);
    expect(await exists(host.dir)).toBe(false);
  });

  it("remembers service images after an interruption removed their containers", async () => {
    const host = await installation();
    await host.save();
    const service: Docker = {
      containers: [{ name: "sanctum-mosquitto", image: "mosquitto-image" }],
      volumes: [{ name: "sanctum-core-data" }],
    };

    await expect(
      host.uninstall(service, {
        args: ["--yes"],
        env: { INSTALL_TEST_FAIL_COMMAND: "volume rm" },
      }),
    ).rejects.toThrow();

    expect(changing(await host.commands())).toContain(
      "docker rm -f -v sanctum-mosquitto",
    );
    await host.uninstall({ volumes: service.volumes }, { args: ["--yes"] });

    expect(changing(await host.commands())).toContain(
      "docker image rm -f mosquitto-image",
    );
    expect(await exists(host.dir)).toBe(false);
  });

  it("waits for Docker rather than removing half", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_DOCKER_STOPPED: "1" },
      }),
    ).rejects.toThrow("Docker, which is not running");

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
  });

  it.each(["container", "volume", "network"])(
    "keeps its installation files when listing managed %ss fails",
    async (kind) => {
      const host = await installation();
      await host.save();

      await expect(
        host.uninstall(home, {
          args: ["--yes"],
          env: {
            INSTALL_TEST_FAIL_COMMAND: `${kind} ls ${kind === "container" ? "-a " : ""}--filter label=sanctum.managed=true`,
          },
        }),
      ).rejects.toThrow("Docker query failed");

      expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
      expect(await exists(join(host.dir, "compose.yml"))).toBe(true);
    },
  );

  it("does not mistake a failed ownership query for no installation", async () => {
    const host = await installation();

    await expect(
      host.uninstall(
        {},
        {
          args: ["--yes"],
          env: {
            INSTALL_TEST_FAIL_COMMAND: "container ls -a --filter",
          },
        },
      ),
    ).rejects.toThrow("Docker query failed");

    expect(changing(await host.commands())).toEqual([]);
  });

  it.each(["image ls", "image inspect", "inspect -f {{.Image}}"])(
    "keeps its installation files when collecting images fails at %s",
    async (command) => {
      const host = await installation();
      await host.save();

      await expect(
        host.uninstall(home, {
          args: ["--yes"],
          env: { INSTALL_TEST_FAIL_COMMAND: command },
        }),
      ).rejects.toThrow("Docker query failed");

      expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
      expect((await host.commands()).some(({ args }) => args[0] === "rm")).toBe(
        false,
      );
    },
  );

  it("does not delete an image when it cannot check who uses it", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_FAIL_COMMAND: "ps -aq --filter ancestor=" },
      }),
    ).rejects.toThrow("Docker query failed");

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
    expect(
      (await host.commands()).some(
        ({ args }) => args[0] === "image" && args[1] === "rm",
      ),
    ).toBe(false);
  });

  it("finishes when an image is gone already or Docker keeps it", async () => {
    const host = await installation();
    await host.save();

    const { stdout } = await host.uninstall(home, {
      args: ["--yes"],
      env: { INSTALL_TEST_FAIL_COMMAND: "image rm" },
    });

    expect(stdout).toContain("Sanctum is removed");
    expect(await exists(host.dir)).toBe(false);
  });

  it("keeps the images noted when Docker stops answering as they go", async () => {
    const host = await installation();
    await host.save();

    await expect(
      host.uninstall(home, {
        args: ["--yes"],
        env: { INSTALL_TEST_STOPS_AT: "image rm" },
      }),
    ).rejects.toThrow("run this again to finish");

    expect(await host.settings()).toContain("SANCTUM_CHANNEL=edge");
    expect(
      await readFile(join(host.dir, ".uninstall-images"), "utf8"),
    ).toContain("mosquitto-image");
  });

  it("lets a laptop sleep again, and only one it kept awake", async () => {
    const laptop = await installation();
    await laptop.save();
    await mkdir(join(laptop.sleepSettings, ".."));
    await writeFile(laptop.sleepSettings, "[Login]\n");
    const other = await installation();
    await other.save();

    await laptop.uninstall(home, { args: ["--yes"] });
    await other.uninstall(home, { args: ["--yes"] });

    expect(
      changing(await laptop.commands()).filter((each) =>
        each.startsWith("systemctl"),
      ),
    ).toEqual([
      "systemctl unmask --quiet sleep.target suspend.target hibernate.target hybrid-sleep.target",
      "systemctl kill --signal=HUP systemd-logind",
    ]);
    expect(await exists(laptop.sleepSettings)).toBe(false);
    expect(
      (await other.commands()).some(({ tool }) => tool === "systemctl"),
    ).toBe(false);
  });

  it("keeps a folder that holds anything else", async () => {
    const host = await installation();
    await host.save();
    await writeFile(join(host.dir, "notes.txt"), "mine");

    await host.uninstall(home, { args: ["--yes"] });

    expect(await exists(join(host.dir, "notes.txt"))).toBe(true);
    expect(await exists(join(host.dir, "compose.yml"))).toBe(false);
    expect(await exists(join(host.dir, ".env"))).toBe(false);
  });

  it("takes no channel when removing, and no --yes when installing", async () => {
    const host = await installation();

    await expect(
      host.run(["--uninstall", "--channel", "edge"]),
    ).rejects.toThrow("Usage");
    await expect(host.run(["--yes"])).rejects.toThrow("Usage");

    expect(await host.commands()).toEqual([]);
  });
});
