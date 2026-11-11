import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// macOS keys an app's Local Network permission to its executable's Mach-O
// UUID, and Electron's executables carry the same UUIDs in every app built
// from them: unchanged, Sanctum would get whatever macOS decided for
// "Electron". `ownUuid` gives an executable a UUID of its own, made from
// `salt` and the one it had, so every build of the app keeps the same one.
// The executable must be signed again afterwards.

const machHeader64 = 0xfeedfacf;
const machHeader64Size = 32;
const loadCommandUuid = 0x1b;

export function ownUuid(executable: Buffer, salt: string) {
  if (executable.readUInt32LE(0) !== machHeader64) {
    throw new Error("Not a thin 64-bit Mach-O executable");
  }
  const commands = executable.readUInt32LE(16);
  let offset = machHeader64Size;
  for (let index = 0; index < commands; index += 1) {
    const command = executable.readUInt32LE(offset);
    if (command === loadCommandUuid) {
      const uuid = executable.subarray(offset + 8, offset + 24);
      const own = createHash("sha256")
        .update(salt)
        .update(uuid)
        .digest()
        .subarray(0, 16);
      // A name-based UUID (RFC 9562, version 5 layout).
      own[6] = (own[6]! & 0x0f) | 0x50;
      own[8] = (own[8]! & 0x3f) | 0x80;
      own.copy(executable, offset + 8);
      return executable;
    }
    offset += executable.readUInt32LE(offset + 4);
  }
  throw new Error("The executable has no UUID");
}

export function giveOwnUuid(file: string, salt: string) {
  writeFileSync(file, ownUuid(readFileSync(file), salt));
}
