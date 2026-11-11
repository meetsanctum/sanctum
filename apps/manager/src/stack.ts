import { z } from "zod";

import type { Labels } from "./docker.js";

// A stack is one Sanctum on a Docker daemon it shares with others: `pnpm dev`
// runs one per worktree. Its containers, volumes and network carry its name
// and a label, so its manager neither sees nor touches another stack's. A host
// runs no stack, so its names stay as they were.

const envSchema = z.object({
  SANCTUM_STACK: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
    .optional(),
  // What a stack's core runs on, which a host decides through updates and
  // fixed settings: its image, its port on the Mac, the worktree's built code
  // mounted over the image's, and its settings, each list split by `;`.
  SANCTUM_STACK_CORE_IMAGE: z.string().min(1).optional(),
  SANCTUM_STACK_CORE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SANCTUM_STACK_CORE_BINDS: z.string().default(""),
  SANCTUM_STACK_CORE_ENV: z.string().default(""),
});

const env = envSchema.parse(process.env);
const list = (value: string) => value.split(";").filter((each) => each !== "");

export const stack = env.SANCTUM_STACK ?? null;
export const stackLabel = "sanctum.stack";

export const stackCore = stack
  ? {
      image: env.SANCTUM_STACK_CORE_IMAGE,
      port: env.SANCTUM_STACK_CORE_PORT,
      binds: list(env.SANCTUM_STACK_CORE_BINDS),
      env: list(env.SANCTUM_STACK_CORE_ENV),
    }
  : null;

// "sanctum-core" → "sanctum-<stack>-core", and "sanctum" → "sanctum-<stack>".
export function stacked(name: string) {
  return stack ? name.replace(/^sanctum/, `sanctum-${stack}`) : name;
}

export function stackLabels(): Labels {
  return stack ? { [stackLabel]: stack } : {};
}

// Whether something labelled so belongs to this stack, or on a host to no
// stack at all.
export function isOurs(labels: Labels | null | undefined) {
  return (labels?.[stackLabel] ?? null) === stack;
}

// A stack stops when its `pnpm dev` does, and must not come back with Docker.
// Its manager still restarts what it finds stopped while it runs.
export const restartPolicy = { Name: stack ? "no" : "unless-stopped" };
