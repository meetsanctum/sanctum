import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineAction,
  defineApp,
  defineEntityType,
  moodRunSchema,
  moodType,
  sameSchema,
  toStaticManifest,
  type ActionDefinition,
  type AppDefinition,
  type EntityTypeDefinition,
} from "../src/index.js";

// An action that runs a standard type's entities, such as moods: it runs a
// type the app provides, in an everyday tier, answering what running one
// answers and, offered to AI agents, needing the type's switch, one action
// for each type, and the manifest says so for readers that run them. A type
// that runs carries the input its app's action takes.

const run = (changes: Partial<ActionDefinition> = {}) =>
  defineAction({
    id: "example.runMood",
    title: "Run a mood",
    tier: "write",
    input: z.object({ id: z.string() }),
    output: moodRunSchema,
    runs: moodType.id,
    run: async () => ({ switched: 0, failed: [] }),
    ...changes,
  } as ActionDefinition);

const note = defineEntityType({
  id: "example.note",
  title: "Note",
  state: z.object({ input: z.object({}) }),
});

function app(
  actions: ActionDefinition[] = [run()],
  entities: EntityTypeDefinition[] = [moodType],
): AppDefinition {
  return {
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [],
    actions,
    events: [],
    provides: { entities: [...entities, note] },
  };
}

describe("an action that runs entities", () => {
  it("says which standard type it runs in the manifest", () => {
    const manifest = toStaticManifest(defineApp(app()));

    expect(manifest.actions[0]).toMatchObject({
      id: "example.runMood",
      runs: "mood",
    });
    expect(manifest.provides.entities[0]).toMatchObject({
      id: "mood",
      standard: true,
    });
  });

  it("leaves runs out of an action that runs nothing", () => {
    const manifest = toStaticManifest(
      defineApp(app([run({ runs: undefined })])),
    );

    expect(manifest.actions[0]).not.toHaveProperty("runs");
  });

  it("runs only a standard type with a run, which the app provides", () => {
    expect(() => defineApp(app([run({ runs: "example.note" })]))).toThrow(
      /runs example.note, which is not a standard type that runs/,
    );
    expect(() => defineApp(app([run({ runs: "sun" })]))).toThrow(
      /not a standard type that runs/,
    );
    expect(() => defineApp(app([run()], []))).toThrow(
      /runs mood, which the app does not provide/,
    );
  });

  it("is read or write, and the only one for its type", () => {
    expect(() => defineApp(app([run({ tier: "destructive" })]))).toThrow(
      /runs mood, so it is read or write/,
    );
    expect(() =>
      defineApp(app([run(), run({ id: "example.runAgain" })])),
    ).toThrow(/Two of the app's actions run mood/);
  });

  it("answers what running one answers", () => {
    const output = z.object({
      switched: z.number(),
      failed: z.array(z.never()),
    });

    expect(() => defineApp(app([run({ output })]))).toThrow(
      /runs mood, so it answers what running one answers/,
    );
  });

  it("accepts the standard output with its fields in a different order", () => {
    const { switched, failed } = moodRunSchema.shape;
    const output = z.object({ failed, switched });

    expect(() => defineApp(app([run({ output })]))).not.toThrow();
    expect(sameSchema(moodRunSchema, z.toJSONSchema(output))).toBe(true);
  });

  it("preserves array order in a literal object inside a schema", () => {
    const first = { required: ["placeholder", "other"] };
    const reversed = { required: ["other", "placeholder"] };
    const constant = z.looseObject({}).meta({ const: first });

    expect(
      sameSchema(constant, { ...z.toJSONSchema(constant), const: reversed }),
    ).toBe(false);
  });

  it("needs the type's switch when it's offered to AI agents", () => {
    const offered = (needs: string[]) =>
      run({ assistant: { starts: "on", description: "Run a mood.", needs } });

    expect(() => defineApp(app([offered(["devices.control:light"])]))).toThrow(
      /AI agents need mood to use it/,
    );
    expect(() => defineApp(app([offered([moodType.id])]))).not.toThrow();
  });
});

describe("a standard type that runs", () => {
  it("holds the input its app's action takes", () => {
    const definition = {
      id: moodType.id,
      title: moodType.title,
      standard: true,
      state: z.object({ name: z.string() }),
      run: { output: moodRunSchema, description: "Runs a scene." },
    };

    expect(() => defineEntityType(definition)).toThrow(
      /runs, so its state has input/,
    );
    expect(() =>
      defineEntityType({
        ...definition,
        state: z.object({ input: z.record(z.string(), z.unknown()) }),
      }),
    ).not.toThrow();
  });

  it("rejects run metadata on a custom type", () => {
    const custom = defineEntityType({
      ...note,
      id: "example.runnableNote",
      run: moodType.run,
    });

    expect(() => defineApp(app([], [custom]))).toThrow(
      /Only standard entity types can run/,
    );
  });
});
