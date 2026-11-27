import { describe, expect, it } from "vitest";

import { compare, date, list, number, plural } from "../src/words.js";

// Numbers, counts, lists, dates and the order of names, each as the
// language writes it.

describe("a language's words", () => {
  it("writes numbers in the language's locale", () => {
    expect(number("en", 1250.5)).toBe("1,250.5");
    expect(number("de", 1250.5)).toBe("1.250,5");
    expect(number("en", 2.345, { maximumFractionDigits: 1 })).toBe("2.3");
  });

  it("gives a count the noun its number takes", () => {
    const lights = { one: "# light", other: "# lights" };
    expect(plural("en", 1, lights)).toBe("1 light");
    expect(plural("en", 0, lights)).toBe("0 lights");
    expect(plural("en", 1200, lights)).toBe("1,200 lights");
    expect(plural("de", 3, { one: "# Licht", other: "# Lichter" })).toBe(
      "3 Lichter",
    );
  });

  it("joins items as a list, or as a choice", () => {
    expect(list("en", ["a", "b", "c"])).toBe("a, b and c");
    expect(list("de", ["a", "b", "c"])).toBe("a, b und c");
    expect(list("en", ["a", "b"], "disjunction")).toBe("a or b");
    expect(list("en", ["a"])).toBe("a");
    expect(list("en", [])).toBe("");
  });

  it("writes dates in the language's locale", () => {
    const at = Date.UTC(2026, 10, 27, 12);
    const options = {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    } as const;
    expect(date("en", at, options)).toBe("27 November");
    expect(date("de", at, options)).toBe("27. November");
  });

  it("orders names with the numbers in them by value", () => {
    const names = ["Light 10", "light 2", "Lamp"];
    expect([...names].sort(compare("en"))).toEqual([
      "Lamp",
      "light 2",
      "Light 10",
    ]);
    expect(compare("en")).toBe(compare("en"));
  });
});
