// What changes a device's place on its driver's network takes turns, one at a
// time for each device: adding, repairing and removing it. A second press of
// Add or Repair, or a Remove while either is under way, waits for the first to
// end rather than racing it to the device. Turns go by the driver and its key
// for the device, which a device has before the core gives it an id.
//
// A turn lasts until what it handed the driver has ended, even once the core
// has stopped waiting for its answer: the driver's code goes on after its
// time is up, until it answers or the core drops its connection, a while
// after the deadline (app-host/link.ts), so nothing after it overlaps it.

/** Keeps the turn until what the driver was handed has ended. */
export type Hold = (running: Promise<unknown>) => void;

export function createTurns() {
  const last = new Map<string, Promise<void>>();
  return {
    take<T>(
      device: { driver: string; key: string },
      work: (hold: Hold) => Promise<T>,
    ): Promise<T> {
      const turn = `${device.driver}\u0000${device.key}`;
      const before = last.get(turn) ?? Promise.resolve();
      const holds: Promise<unknown>[] = [];
      const mine = before.then(() =>
        work((running) => void holds.push(running)),
      );
      const ended = mine
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => Promise.allSettled(holds))
        .then(() => undefined);
      last.set(turn, ended);
      void ended.then(() => {
        if (last.get(turn) === ended) last.delete(turn);
      });
      return mine;
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;
