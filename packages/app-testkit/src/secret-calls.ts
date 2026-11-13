import {
  maxAppSecrets,
  maxSecretBytes,
  secretNamePattern,
  type CoreCalls,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

// Both test cores keep an app's secrets and refuse the same names and values
// as the real core, without writing credentials to a test database.
export function createSecretCalls(
  appId: string,
  refuse: (error: Error) => never = (error) => {
    throw error;
  },
) {
  const secrets = new Map<string, string>();
  const nameSchema = z.string().regex(secretNamePattern);
  const secretSchema = z.object({
    name: nameSchema,
    value: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= maxSecretBytes),
  });

  function named(name: unknown) {
    const parsed = nameSchema.safeParse(name);
    if (!parsed.success) {
      refuse(new Error(`${appId} named a secret the core cannot keep`));
    }
    return parsed.data;
  }

  const calls: Pick<CoreCalls, "secret" | "putSecret" | "removeSecret"> = {
    async secret(name) {
      return secrets.get(named(name)) ?? null;
    },
    async putSecret(input) {
      const parsed = secretSchema.safeParse(input);
      if (!parsed.success) {
        refuse(new Error(`${appId} kept a secret the core cannot keep`));
      }
      const { name, value } = parsed.data;
      if (!secrets.has(name) && secrets.size >= maxAppSecrets) {
        refuse(new Error(`${appId} keeps ${maxAppSecrets} secrets already`));
      }
      secrets.set(name, value);
    },
    async removeSecret(name) {
      secrets.delete(named(name));
    },
  };

  return { secrets, calls };
}
