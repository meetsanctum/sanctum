import {
  defineApp,
  type Actor,
  type AppContext,
  type DriverAddResult,
  type DriverRepairResult,
  type FoundReport,
} from "@meetsanctum/app-sdk";

// A driver app for the tests whose devices ask once adding or repairing has
// started, as a TV shows a pairing code only then: a first code, then a
// second one that lasts 35 seconds. A wrong first code is refused with a new
// one asked for; a wrong second code ends it. Adding registers the TV once
// both codes match, and repairing clears its lost pairing.

type Step = {
  key: string;
  answers: Record<string, string>;
  attempt?: string;
  again?: string;
};

class Screens {
  // What the core asked, in order: "add tv-1", "add tv-1 firstCode", "add
  // tv-1 again secondCode", "cancelAdd tv-1".
  readonly calls: string[] = [];
  // The attempt and actor each call came with, in the same order.
  readonly attempts: (string | undefined)[] = [];
  readonly actors: Actor[] = [];
  // The attempt each TV has a pairing open for, until it ends.
  readonly open = new Map<string, string>();
  firstCode = "1234";
  secondCode = "0042";
  // Holds a driver step until the test lets it proceed.
  beforeStep?: () => Promise<void>;
  // Asks what it doesn't declare, as a careless driver would.
  asksUndeclared = false;
  // Throws, as a driver whose connection broke would.
  fails = false;
  private ctx?: AppContext;

  get running() {
    return this.ctx !== undefined;
  }

  attach(ctx: AppContext) {
    this.ctx = ctx;
  }

  detach() {
    this.open.clear();
    this.ctx = undefined;
  }

  reset() {
    this.calls.length = 0;
    this.attempts.length = 0;
    this.actors.length = 0;
    this.open.clear();
    this.firstCode = "1234";
    this.secondCode = "0042";
    this.beforeStep = undefined;
    this.asksUndeclared = false;
    this.fails = false;
  }

  sayFound(found: FoundReport[]) {
    return this.ctx!.devices.found(found);
  }

  register(key: string, name: string) {
    return this.ctx!.devices.register({
      key,
      name,
      manufacturer: "Test",
      model: "TV box",
      type: "unknown",
      capabilities: [],
    });
  }

  sayProblem(key: string, problem: string | null) {
    return this.ctx!.devices.problem({ key, problem });
  }

  // One step of pairing: what it asks next, a refusal, or done.
  async pair(
    what: "add" | "repair",
    step: Step,
    actor: Actor,
    done: () => Promise<unknown>,
  ): Promise<DriverAddResult & DriverRepairResult> {
    const answered = Object.keys(step.answers).map((id) => ` ${id}`);
    this.calls.push(
      `${what} ${step.key}${step.again ? ` again ${step.again}` : ""}${answered.join("")}`,
    );
    this.attempts.push(step.attempt);
    this.actors.push(actor);
    await this.beforeStep?.();
    if (this.fails)
      throw new Error(`pairing with code ${step.answers.firstCode} broke`);
    if (this.asksUndeclared) return { asks: ["volume"] };
    if (step.attempt !== undefined) this.open.set(step.key, step.attempt);
    if (step.again) return { asks: [step.again] };
    if ("firstCode" in step.answers) {
      return step.answers.firstCode === this.firstCode
        ? { asks: ["secondCode"] }
        : {
            asks: ["firstCode"],
            refused: { question: "firstCode", refusal: "wrongCode" },
          };
    }
    if ("secondCode" in step.answers) {
      if (step.answers.secondCode !== this.secondCode) {
        return { refused: { question: "secondCode", refusal: "wrongCode" } };
      }
      this.open.delete(step.key);
      await done();
      return;
    }
    return { asks: ["firstCode"] };
  }

  cancel(what: string, key: string, attempt: string, actor: Actor) {
    this.calls.push(`${what} ${key}`);
    this.attempts.push(attempt);
    this.actors.push(actor);
    if (this.open.get(key) === attempt) this.open.delete(key);
  }
}

export const screens = new Screens();

const code = (label: string) => ({
  label,
  kind: "code" as const,
  length: 4,
  refusals: { wrongCode: "That code didn't match." },
});

export default defineApp({
  id: "sanctum.example",
  name: "TVs",
  version: "0.1.0",
  core: "^2.0.0",
  permissions: [
    { id: "devices.register", reason: "For the test.", needed: true },
  ],
  actions: [],
  events: [],
  async start(ctx) {
    screens.attach(ctx);
  },
  async stop() {
    screens.detach();
  },
  driver: {
    async command() {},
    questions: {
      firstCode: code("Code on the TV (1 of 2)"),
      secondCode: {
        ...code("Code on the TV (2 of 2)"),
        help: "A new code is on the TV.",
        lasts: { seconds: 35, again: "Show a new code" },
      },
    },
    addLater: ["firstCode", "secondCode"],
    problems: {
      pairingLost: {
        words: "Its pairing was removed",
        repair: {
          help: "Pair it again. The TV shows two codes, one after the other.",
          asks: [],
          later: ["firstCode", "secondCode"],
        },
      },
    },
    async add(ctx, add) {
      return screens.pair("add", add, ctx.actor, () =>
        screens.register(add.key, add.key),
      );
    },
    async cancelAdd(ctx, { key, attempt }) {
      screens.cancel("cancelAdd", key, attempt, ctx.actor);
    },
    async repair(ctx, repair) {
      return screens.pair("repair", repair, ctx.actor, () =>
        screens.sayProblem(repair.key, null),
      );
    },
    async cancelRepair(ctx, { key, attempt }) {
      screens.cancel("cancelRepair", key, attempt, ctx.actor);
    },
  },
});
