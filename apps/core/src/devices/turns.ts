// What changes a device's place on its driver's network takes turns, one at a
// time for each device: adding, repairing and removing it. A second press of
// Add or Repair, or a Remove while either is under way, waits for the first to
// end rather than racing it to the device. Turns go by the driver and its key
// for the device, which a device has before the core gives it an id.
export function createTurns() {
  const last = new Map<string, Promise<void>>();
  return {
    take<T>(
      device: { driver: string; key: string },
      work: () => Promise<T>,
    ): Promise<T> {
      const turn = `${device.driver}\u0000${device.key}`;
      const before = last.get(turn) ?? Promise.resolve();
      const mine = before.then(work);
      const ended = mine.then(
        () => undefined,
        () => undefined,
      );
      last.set(turn, ended);
      void ended.then(() => {
        if (last.get(turn) === ended) last.delete(turn);
      });
      return mine;
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;
