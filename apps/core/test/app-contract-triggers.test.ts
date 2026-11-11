import {
  defineAction,
  defineApp,
  defineEvent,
  defineTrigger,
  toStaticManifest,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { expect, it } from "vitest";
import { z } from "zod";

import { claimed, testCore } from "./support.js";
import { addWorkflow, steps } from "./workflows-support.js";

it.each([false, true])(
  "matches the checked event against its trigger's defaulted union branch (event default: %s)",
  async (hasEventDefault) => {
    const event = defineEvent({
      id: "contract.happened",
      payload: z.object({
        place: z.object({ kind: z.string(), label: z.string().optional() }),
      }),
    });
    const received: string[] = [];
    const note = defineAction({
      id: "contract.note",
      title: "Note",
      tier: "write",
      input: z.object({}),
      output: z.object({}),
      async run() {
        received.push("ran");
        return {};
      },
    });
    let context: AppContext | undefined;
    const app = defineApp({
      id: "test.contract",
      name: "Contract",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [note],
      events: [event],
      provides: {
        triggers: [
          defineTrigger({
            id: "contract.happened",
            title: "Something happened",
            event,
            config: z.object({
              place: z.union([
                z.object({
                  kind: z.literal("room"),
                  label: z.string().default("Study"),
                }),
                z.object({
                  kind: z.literal("home"),
                  label: z.string().default("Home"),
                }),
              ]),
            }),
          }),
        ],
        steps: [note],
      },
      async start(ctx) {
        context = ctx;
      },
    });
    const manifest = toStaticManifest(app);
    if (hasEventDefault) {
      const payload = manifest.events[0]!.payload as unknown as {
        properties: {
          place: { properties: { label: Record<string, unknown> } };
        };
      };
      payload.properties.place.properties.label.default = "Home";
    }
    const core = await testCore({
      apps: [{ app, manifest, origin: "official" }],
    });
    const { token } = await claimed(core);
    await addWorkflow(core, token, {
      graph: steps(
        {
          id: "t",
          app: app.id,
          kind: "trigger",
          piece: "contract.happened",
          config: { place: { kind: "home" } },
        },
        { id: "note", app: app.id, kind: "step", piece: note.id, config: {} },
      ),
    });

    await context!.events.emit(event, {
      place: { kind: "home", ...(hasEventDefault ? {} : { label: "Home" }) },
    });

    await expect.poll(() => received).toEqual(["ran"]);
  },
);
