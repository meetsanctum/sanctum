import { entityOf, names } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { namedIn, namedInSchema } from "../src/workflows/named.js";

// Each is found at its field's path in the config; one the config's schema
// itself names has none.

describe("declared references through schema composition", () => {
  it.each([
    ["a default", names("room").default("study"), undefined, ""],
    ["a prefault", names("room").prefault("study"), undefined, ""],
    ["a catch", names("room").catch("study"), 42, ""],
    ["a rejected string", names("room").catch("study"), "", ""],
    [
      "a nested default",
      z.object({ room: names("room") }).default({ room: "study" }),
      undefined,
      "room",
    ],
    ["a tuple rest", z.tuple([z.number()], names("room")), [1, "study"], "1"],
    [
      "a record key",
      z.record(names("room"), z.boolean()),
      { study: true },
      "study",
    ],
    [
      "a record value",
      z.record(z.string(), names("room")),
      { first: "study" },
      "first",
    ],
    [
      "a catchall",
      z.object({}).catchall(names("room")),
      { first: "study" },
      "first",
    ],
    ["a pipe's output", z.string().pipe(names("room")), "study", ""],
    [
      "a preprocess",
      z.preprocess((value) => String(value).toLowerCase(), names("room")),
      "STUDY",
      "",
    ],
    [
      "a pipe's input",
      names("room").transform((value) => ({ id: value })),
      "study",
      "",
    ],
    [
      "a default after a transform",
      z.number().transform(String).pipe(names("room")).default("study"),
      undefined,
      "",
    ],
    [
      "a prefault before a transform",
      z
        .string()
        .transform((value) => value.toLowerCase())
        .pipe(names("room"))
        .prefault("STUDY"),
      undefined,
      "",
    ],
    [
      "a fallback after a transform",
      z.number().transform(String).pipe(names("room")).catch("study"),
      null,
      "",
    ],
  ])("finds %s", (_label, schema, value, field) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(namedIn(schema, value)).toEqual([
      { kind: "room", id: "study", field },
    ]);
  });

  it("does not scan undeclared extra properties", () => {
    expect(
      namedIn(z.looseObject({ note: z.string() }), {
        note: "study",
        room: "study",
      }),
    ).toEqual([]);
  });

  it("follows the input branch of a transforming union", () => {
    const schema = z.union([
      z.object({ room: names("room") }).transform(({ room }) => ({ id: room })),
      z.object({ id: z.string() }),
    ]);
    expect(namedIn(schema, { room: "study" })).toEqual([
      { kind: "room", id: "study", field: "room" },
    ]);
    expect(namedIn(schema, { id: "study" })).toEqual([]);
  });
});

describe("an entity a config names", () => {
  it("is found with its type, by zod and by its JSON Schema", () => {
    const schema = z.object({ mood: entityOf("test.mood") });
    const config = { mood: "calm" };
    const found = [
      { kind: "entity", type: "test.mood", id: "calm", field: "mood" },
    ];

    expect(namedIn(schema, config)).toEqual(found);
    expect(namedInSchema(z.toJSONSchema(schema), config)).toEqual(found);
  });

  it("isn't found where nothing is chosen", () => {
    const schema = z.object({ mood: entityOf("test.mood").optional() });

    expect(namedIn(schema, {})).toEqual([]);
    expect(namedInSchema(z.toJSONSchema(schema), {})).toEqual([]);
  });
});
