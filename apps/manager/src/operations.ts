// Only one of these runs at a time. Each writes every step to a journal of its own
// before taking it, and those journals say who holds the slot, whichever process
// wrote them. So there is nothing else to keep in step: a crash can't leave the
// slot held by something that has ended, and a manager that starts finds what it
// was doing by reading them. Keeping services running and signing certificates stay
// outside it.

export type Operation =
  | { kind: "core-update"; version: string }
  | { kind: "service-image"; service: string; to: string }
  | { kind: "app-update"; app: string; to: string };

export class OperationConflictError extends Error {
  constructor(readonly holder: Operation) {
    super(
      holder.kind === "core-update"
        ? "An update is already running"
        : `${holder.kind === "app-update" ? holder.app : holder.service} is moving to another version`,
    );
  }
}

type Holder = (
  continuing?: Operation,
) => Operation | null | Promise<Operation | null>;

const isSameOperation = (holder: Operation, continuing?: Operation) =>
  JSON.stringify(holder) === JSON.stringify(continuing);

export function createOperations() {
  const journals: Holder[] = [];
  // One that has been claimed and hasn't written its journal yet.
  let claiming: Operation | null = null;

  async function inJournals(continuing?: Operation) {
    for (const read of journals) {
      const holder = await read(continuing);
      if (holder && !isSameOperation(holder, continuing)) return holder;
    }
    return null;
  }

  return {
    /**
     * Adds what says, from its journal, that an operation holds the slot. A journal
     * with several entries skips only the operation being continued.
     */
    heldBy(read: Holder) {
      journals.push(read);
    },

    /** What holds the slot now, if anything. */
    current: async () => claiming ?? (await inJournals()),

    /**
     * Runs `begin` holding the slot, or refuses with OperationConflictError. The
     * operation holds on past it through what `begin` wrote to its journal; one
     * that wrote nothing has given the slot up. Continuing an operation ignores
     * its own journal, but still checks every other one.
     */
    async claim<T>(
      operation: Operation,
      begin: () => Promise<T>,
      { isContinuing = false }: { isContinuing?: boolean } = {},
    ) {
      // Before the first await, so two can't both find it free.
      if (claiming) throw new OperationConflictError(claiming);
      claiming = operation;
      try {
        const holder = await inJournals(isContinuing ? operation : undefined);
        if (holder) throw new OperationConflictError(holder);
        return await begin();
      } finally {
        claiming = null;
      }
    },
  };
}

export type Operations = ReturnType<typeof createOperations>;
