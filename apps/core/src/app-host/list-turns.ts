// Changes to the home's list of apps take turns, one at a time: an add
// checks the memory and space left by the one before, and adding an app
// back waits for its removal to end.

export function createListTurns() {
  let last: Promise<unknown> = Promise.resolve();
  return {
    take<T>(work: () => Promise<T>): Promise<T> {
      const mine = last.then(work);
      last = mine.catch(() => undefined);
      return mine;
    },
  };
}

export type ListTurns = ReturnType<typeof createListTurns>;
