// Pairing the way a TV box does, for Add and Repair to try out: a first code
// once pairing starts, then a second once the first is accepted, which lasts
// 35 seconds. Any four digits are the code it shows, except 0000, which it
// refuses: a wrong first code shows a new one, and a wrong second code ends
// pairing. Each attempt keeps what it opened until it pairs or ends, and a
// new attempt drops whatever an earlier one left.

/** How long the second code lasts, as the TV box keeps it. */
export const secondCodeMs = 35_000;

export function createPairing(options = {}) {
  const now = options.now ?? Date.now;
  // What each device has open, by its key: the attempt, and until when the
  // second code it shows is good.
  const open = new Map();

  return {
    /**
     * One step of pairing a device: what it asks next, a refusal, or
     * "paired" once both codes matched.
     */
    step(key, { answers, attempt, again }) {
      if (open.get(key)?.attempt !== attempt) {
        open.set(key, { attempt, secondUntil: null });
      }
      const pairing = open.get(key);
      if (again === "secondCode") {
        pairing.secondUntil = now() + secondCodeMs;
        return { asks: ["secondCode"] };
      }
      if ("firstCode" in answers) {
        if (answers.firstCode === "0000") {
          return {
            asks: ["firstCode"],
            refused: { question: "firstCode", refusal: "wrongCode" },
          };
        }
        pairing.secondUntil = now() + secondCodeMs;
        return { asks: ["secondCode"] };
      }
      if ("secondCode" in answers) {
        open.delete(key);
        if (answers.secondCode === "0000" || now() > pairing.secondUntil) {
          return { refused: { question: "secondCode", refusal: "wrongCode" } };
        }
        return "paired";
      }
      return { asks: ["firstCode"] };
    },

    /** Closes what an attempt opened, as Cancel does. */
    cancel(key, attempt) {
      if (open.get(key)?.attempt === attempt) open.delete(key);
    },

    /** Closes everything, as the driver stops. */
    clear() {
      open.clear();
    },

    /** Whether a device has pairing open, for its tests. */
    isOpen(key) {
      return open.has(key);
    },
  };
}
