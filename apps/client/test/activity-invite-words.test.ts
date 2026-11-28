import { homeClock } from "@meetsanctum/app-sdk/clock";
import { describe, expect, it } from "vitest";

import { activityWords } from "../src/activity/words";
import { productName } from "../src/brand";
import { entry } from "./activity-fixtures";

const clock = homeClock();

describe("Activity for invites", () => {
  it.each([
    ["invite.create", "ok", null, "Invited Jonas to sign in", false],
    [
      "invite.create",
      "ok",
      "reset",
      "Made Jonas a code for a new password",
      false,
    ],
    ["invite.create", "ok", "recovery", "Made a recovery code", false],
    ["invite.cancel", "ok", null, "Cancelled Jonas's invite", false],
    [
      "invite.redeem",
      "ok",
      "recovery",
      "Chose a new password with a recovery code",
      false,
    ],
    ["invite.redeem", "ok", null, "Joined with an invite code", false],
    ["invite.redeem", "ok", "reset", "Chose a new password with a code", false],
    [
      "invite.redeem",
      "refused",
      "too_many_attempts",
      "Jonas's invite code was tried too often",
      true,
    ],
    [
      "invite.redeem",
      "refused",
      "channel_mismatch",
      `A device using an invite code wasn't connected to ${productName} directly`,
      true,
    ],
  ] as const)(
    "says what an invite did (%s, %s, %s)",
    (action, outcome, reason, title, problem) => {
      expect(
        activityWords(
          clock,
          entry({
            kind: "system",
            source: "auth",
            action,
            outcome,
            reason,
            detail: null,
            subject: {
              type: "person",
              id: "jonas",
              name: "Jonas",
              gone: false,
            },
          }),
          "home",
        ),
      ).toMatchObject({ title, problem });
    },
  );
});

it("describes password recovery from a signed-in device", () => {
  expect(
    activityWords(
      clock,
      entry({
        kind: "system",
        source: "auth",
        action: "password.choose",
        detail: null,
        subject: { type: "person", id: "jonas", name: "Jonas", gone: false },
      }),
      "home",
    ),
  ).toMatchObject({
    title: "Chose a new password without the old one",
    problem: false,
  });
});
