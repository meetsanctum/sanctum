// What changes a device's place on its driver's network takes turns, one at a
// time for each device: removing and repairing it. A second press of Repair,
// or a Remove while a repair is under way, waits for the first to end rather
// than racing it to the device.
export function createTurns() {
  const last = new Map<string, Promise<void>>();
  return {
    take<T>(id: string, work: () => Promise<T>): Promise<T> {
      const before = last.get(id) ?? Promise.resolve();
      const mine = before.then(work);
      const ended = mine.then(
        () => undefined,
        () => undefined,
      );
      last.set(id, ended);
      void ended.then(() => {
        if (last.get(id) === ended) last.delete(id);
      });
      return mine;
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;
