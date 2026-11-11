import { execFile } from "node:child_process";

// Whether the host's clock is synchronised. The manager asks the kernel, as
// systemd does for `timedatectl`: a clock is synchronised while the maximum
// error the time daemon reports is under 16 seconds. Reading it needs no
// privilege, so the manager's container can, through busybox's `adjtimex` in
// its Alpine image.

const unsynchronisedMicros = 16_000_000;

// The `maxerror` line of `adjtimex`'s report, in microseconds.
export function isSynchronised(report: string) {
  const match = /^\s*maxerror:\s*(\d+)/m.exec(report);
  return match ? Number(match[1]) < unsynchronisedMicros : null;
}

// True or false, or null where the kernel can't be asked, as off Linux.
export function readClock(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("busybox", ["adjtimex"], { timeout: 2_000 }, (error, stdout) =>
      resolve(error ? null : isSynchronised(stdout)),
    );
  });
}
