import {
  CodeExpired,
  NotAllowed,
  Unreachable,
  WrongCode,
  type Boxes,
  type Endpoint,
  type Keys,
  type Pairing,
} from "./boxes.js";

// Pairing a box, step by step, as adding or repairing one asks: AirPlay's
// code, then Companion's, each read off the TV while its pairing connection
// is held open. One pairing per box at a time, by the attempt the core names:
// a new attempt closes whatever the last one left open. The first
// protocol's keys stay in memory until the second passes, so an attempt
// that stops halfway saves nothing.

/** Both protocols' keys, as one box's secret keeps them. */
export type BoxKeys = { airplay: Keys; companion: Keys };

/** One step of an attempt, as driver.add and driver.repair hand it over. */
export type PairingStep = {
  attempt?: string;
  answers: Record<string, string>;
  again?: string;
};

/** What a step answers: what it asks next, a refusal that ends it, or done. */
export type PairingAnswer =
  | { asks: string[]; refused?: { question: string; refusal: string } }
  | { refused: { question?: string; refusal: string } }
  | undefined;

export const airplayCode = "airplayCode";
export const companionCode = "companionCode";

type Open =
  | { attempt: string; step: "airplay"; pairing: Pairing }
  | { attempt: string; step: "companion"; pairing: Pairing; airplay: Keys };

export type PairingOptions = {
  /** How long to wait before trying a Companion pairing again, in ms. */
  retryMs?: number;
};

export function createPairings(boxes: Boxes, options: PairingOptions = {}) {
  const retryMs = options.retryMs ?? 1_000;
  const open = new Map<string, Open>();

  function close(key: string) {
    open.get(key)?.pairing.close();
    open.delete(key);
  }

  // A refusal that ends the attempt, for what stopped the box pairing.
  function refusalOf(error: unknown): PairingAnswer {
    if (error instanceof NotAllowed)
      return { refused: { refusal: "notAllowed" } };
    if (error instanceof Unreachable) {
      return { refused: { refusal: "unreachable" } };
    }
    throw error;
  }

  // A new Companion code. Right after one expires the box may still be
  // closing it, so a failure is tried once more after a moment.
  async function companionPairing(box: Endpoint) {
    try {
      return await boxes.pairCompanion(box);
    } catch (error) {
      if (error instanceof NotAllowed) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      return boxes.pairCompanion(box);
    }
  }

  async function begin(key: string, box: Endpoint, attempt: string) {
    try {
      const pairing = await boxes.pairAirPlay(box);
      open.set(key, { attempt, step: "airplay", pairing });
      return { asks: [airplayCode] };
    } catch (error) {
      return refusalOf(error);
    }
  }

  async function airplay(
    key: string,
    box: Endpoint,
    now: Extract<Open, { step: "airplay" }>,
    code: string,
  ): Promise<PairingAnswer> {
    let keys: Keys;
    try {
      keys = await now.pairing.finish(code);
    } catch (error) {
      open.delete(key);
      if (!(error instanceof WrongCode)) throw error;
      // Where the box shows a new code at once, ask for it; where it won't
      // pair again, the attempt ends and Add starts over.
      try {
        const pairing = await boxes.pairAirPlay(box);
        open.set(key, { attempt: now.attempt, step: "airplay", pairing });
        return {
          asks: [airplayCode],
          refused: { question: airplayCode, refusal: "wrongCode" },
        };
      } catch {
        return { refused: { question: airplayCode, refusal: "wrongCode" } };
      }
    }
    try {
      const pairing = await companionPairing(box);
      open.set(key, {
        attempt: now.attempt,
        step: "companion",
        pairing,
        airplay: keys,
      });
      return { asks: [companionCode] };
    } catch (error) {
      open.delete(key);
      return refusalOf(error);
    }
  }

  async function companion(
    key: string,
    box: Endpoint,
    now: Extract<Open, { step: "companion" }>,
    code: string,
    done: (keys: BoxKeys) => Promise<void>,
  ): Promise<PairingAnswer> {
    let keys: Keys;
    try {
      keys = await now.pairing.finish(code);
    } catch (error) {
      open.delete(key);
      const refusal =
        error instanceof WrongCode
          ? "wrongCode"
          : error instanceof CodeExpired
            ? "expired"
            : null;
      if (!refusal) throw error;
      // Each Companion pairing shows a code of its own, so a new one is
      // asked for at once.
      try {
        const pairing = await companionPairing(box);
        open.set(key, { ...now, pairing });
        return {
          asks: [companionCode],
          refused: { question: companionCode, refusal },
        };
      } catch (again) {
        return refusalOf(again);
      }
    }
    open.delete(key);
    await done({ airplay: now.airplay, companion: keys });
    return undefined;
  }

  return {
    /** Takes one step of pairing a box, calling `done` once both codes pass. */
    async step(
      key: string,
      box: Endpoint,
      { attempt, answers, again }: PairingStep,
      done: (keys: BoxKeys) => Promise<void>,
    ): Promise<PairingAnswer> {
      // The core names an attempt for every flow that asks once started.
      if (attempt === undefined) throw new Error("Pairing needs an attempt");
      const now = open.get(key);
      if (now?.attempt !== attempt) {
        close(key);
        if (again !== undefined || Object.keys(answers).length > 0) {
          throw new Error("No pairing is open for this attempt");
        }
        return begin(key, box, attempt);
      }
      if (again === companionCode && now.step === "companion") {
        now.pairing.close();
        try {
          const pairing = await companionPairing(box);
          open.set(key, { ...now, pairing });
          return { asks: [companionCode] };
        } catch (error) {
          open.delete(key);
          return refusalOf(error);
        }
      }
      const code =
        answers[now.step === "airplay" ? airplayCode : companionCode];
      if (code === undefined || again !== undefined) {
        throw new Error(`This pairing waits for ${now.step}'s code`);
      }
      return now.step === "airplay"
        ? airplay(key, box, now, code)
        : companion(key, box, now, code, done);
    },

    /** Closes the attempt's pairing, if it's still the open one. */
    cancel(key: string, attempt: string) {
      if (open.get(key)?.attempt === attempt) close(key);
    },

    /** Whether a pairing is open for the box. */
    isOpen: (key: string) => open.has(key),

    /** Closes every pairing still open, as the app stops. */
    closeAll() {
      for (const key of [...open.keys()]) close(key);
    },
  };
}

export type Pairings = ReturnType<typeof createPairings>;
