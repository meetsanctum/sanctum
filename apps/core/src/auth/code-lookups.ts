import {
  pairingCodeAlphabet,
  pairingLookupLength,
} from "@meetsanctum/auth-protocol";

const characters = [...pairingCodeAlphabet];

function allLookups() {
  let lookups = [""];
  for (let length = 0; length < pairingLookupLength; length++) {
    lookups = lookups.flatMap((prefix) =>
      characters.map((char) => prefix + char),
    );
  }
  return lookups;
}

// Every lookup that the pairing and invite code parsers accept.
export const codeLookups = allLookups();
