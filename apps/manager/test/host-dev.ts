import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const zbt2 =
  "/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_9C139EACAFF0-if00-port0";
export const conbee =
  "/dev/serial/by-id/usb-dresden_elektronik_ingenieurtechnik_GmbH_ConBee_II_DE2676574-if00";

// A host's /dev, as the manager sees it at /host/dev: ttys, and udev's
// relative links to them under serial/by-id.
export async function hostDev() {
  const root = await mkdtemp(join(tmpdir(), "sanctum-dev-"));
  await mkdir(join(root, "serial", "by-id"), { recursive: true });
  await writeFile(join(root, "ttyAMA0"), "");
  return {
    root,
    async plug(byId: string, tty: string) {
      await writeFile(join(root, tty), "");
      await symlink(
        `../../${tty}`,
        join(root, "serial", "by-id", byId.split("/").at(-1)!),
      );
    },
    async unplug(byId: string, tty: string) {
      await rm(join(root, tty));
      await rm(join(root, "serial", "by-id", byId.split("/").at(-1)!));
    },
  };
}
