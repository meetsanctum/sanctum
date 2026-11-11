// What the core reports: whether the host is claimed, and the id of the
// home it serves.
export type HomeReport = { claimed: boolean; homeId: string };

// The core reports whether the host is claimed and its home's id, which
// only it knows, once it can reach the socket and again when Auth claims it.
// The manager keeps both and announces them. A host that was claimed and
// comes back unclaimed was reset, so it gets a new CA before the core asks
// for its next certificate: the core reports first when it starts.
export function createClaimedReports(options: {
  wasClaimed: () => boolean | undefined;
  save: (report: HomeReport) => Promise<void>;
  replaceCa: () => Promise<void>;
  announce: (report: HomeReport) => void;
}) {
  let reporting: Promise<void> = Promise.resolve();
  return (report: HomeReport) => {
    reporting = reporting
      .catch(() => undefined)
      .then(async () => {
        if (!report.claimed && options.wasClaimed() === true) {
          await options.replaceCa();
        }
        // Save even an unchanged value: an earlier report may have failed.
        await options.save(report);
        options.announce(report);
      });
    return reporting;
  };
}
