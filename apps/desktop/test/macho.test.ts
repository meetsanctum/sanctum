import { describe, expect, it } from "vitest";

import { ownUuid } from "../scripts/macho.ts";

// A thin 64-bit Mach-O header with two load commands: one that is not a
// UUID, then LC_UUID.
function executable(uuid: number[]) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(2, 16);
  const other = Buffer.alloc(16);
  other.writeUInt32LE(0x32, 0);
  other.writeUInt32LE(16, 4);
  const command = Buffer.alloc(24);
  command.writeUInt32LE(0x1b, 0);
  command.writeUInt32LE(24, 4);
  Buffer.from(uuid).copy(command, 8);
  return Buffer.concat([header, other, command]);
}

const electron = Array.from({ length: 16 }, (_, index) => index);
const uuidOf = (file: Buffer) => file.subarray(56, 72).toString("hex");

describe("ownUuid", () => {
  it("replaces the executable's UUID and nothing else", () => {
    const before = executable(electron);
    const after = ownUuid(Buffer.from(before), "com.meetsanctum.desktop");
    expect(uuidOf(after)).not.toBe(uuidOf(before));
    expect(after.subarray(0, 56)).toEqual(before.subarray(0, 56));
    expect(after.length).toBe(before.length);
  });

  it("gives every build the same UUID, and other apps other ones", () => {
    const once = ownUuid(executable(electron), "com.meetsanctum.desktop");
    const again = ownUuid(executable(electron), "com.meetsanctum.desktop");
    const other = ownUuid(executable(electron), "com.example.other");
    expect(uuidOf(again)).toBe(uuidOf(once));
    expect(uuidOf(other)).not.toBe(uuidOf(once));
  });

  it("marks it as a name-based UUID", () => {
    const uuid = ownUuid(
      executable(electron),
      "com.meetsanctum.desktop",
    ).subarray(56, 72);
    expect(uuid[6]! >> 4).toBe(5);
    expect(uuid[8]! >> 6).toBe(0b10);
  });

  it("refuses what is not a thin 64-bit Mach-O", () => {
    expect(() => ownUuid(Buffer.alloc(64), "salt")).toThrow(/Mach-O/);
  });
});
