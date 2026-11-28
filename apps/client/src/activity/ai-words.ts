import {
  modelProviders,
  permissionWords,
  type ActivityInfo,
} from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { number } from "@meetsanctum/app-sdk/words";

import { productName } from "../brand";
import { providerNames } from "../models/words";
import { byWords } from "./actor-words";
import type { Words } from "./words";

// How the activity log's entries of AI read: adding an AI agent and what AI
// agents can use, what they were refused or held back from, the home's AI
// models as the household adds, chooses, changes and removes them, and apps'
// turns with the one in use.

// A source as the entry kept it, such as "Qwen3 8B on Office Mac".
function sourceWords(detail: ActivityInfo["detail"]) {
  const model = typeof detail?.model === "string" ? detail.model : "a model";
  if (typeof detail?.computer === "string") {
    return `${model} on ${detail.computer}`;
  }
  if (detail?.kind === "sanctum") return `${model} on ${productName}`;
  const provider = modelProviders.find((each) => each === detail?.kind);
  return provider ? `${model} with ${providerNames[provider]}` : model;
}

export function aiEntry(clock: HomeClock, entry: ActivityInfo): Words | null {
  const by = byWords(clock, entry);
  const name = entry.subject?.name;
  const said = (title: string) => ({
    title,
    detail: by,
    problem: entry.outcome !== "ok",
  });
  switch (entry.action) {
    // Adding an AI agent: its setup, and the agent's connector collecting
    // its token with the setup's code.
    case "agents.setup": {
      const added = entry.detail?.name;
      return said(
        typeof added === "string"
          ? `Started adding ${added}`
          : "Started adding an AI agent",
      );
    }
    case "agents.setup-cancel":
      return said("Stopped adding an AI agent");
    case "agents.add":
      if (entry.outcome === "ok") return said(`Added ${name ?? "an AI agent"}`);
      return {
        title:
          entry.reason === "too_many_attempts"
            ? "Held back a computer trying codes for adding an AI agent"
            : "Someone tried a wrong code for adding an AI agent",
        detail: by,
        problem: true,
      };
    case "agents.can-use": {
      // An app's offer by the title it kept, one of the core's areas by its
      // permission's words.
      const item = String(entry.detail?.item ?? "");
      const title =
        typeof entry.detail?.title === "string"
          ? entry.detail.title
          : permissionWords(item).title;
      return said(
        entry.detail?.on === true
          ? `Let AI agents use “${title}”`
          : `Stopped AI agents using “${title}”`,
      );
    }
    // One of the core's tools an AI agent called while what it needs is off.
    case "agents.refused": {
      const items = Array.isArray(entry.detail?.items)
        ? entry.detail.items.map(
            (item) => `“${permissionWords(String(item)).title}”`,
          )
        : [];
      return said(
        items.length > 0
          ? `Not allowed: ${items.join(" and ")}`
          : "Not allowed to read what apps bring",
      );
    }
    // An AI agent over one of the endpoint's limits, at most once a minute.
    case "agents.limited":
      return said(
        entry.reason === "at_once"
          ? "Held back for asking too much at once"
          : entry.reason === "commands"
            ? "Held back for changing devices too often"
            : "Held back for asking too often",
      );
    case "models.add":
      return said(`Added ${sourceWords(entry.detail)} to AI models`);
    case "models.use":
      return said(`Chose ${sourceWords(entry.detail)} as the AI model in use`);
    case "models.change":
      return said(
        entry.detail?.key === true
          ? `Replaced the key for ${sourceWords(entry.detail)}`
          : `Changed ${sourceWords(entry.detail)}`,
      );
    case "models.remove":
      return said(`Removed ${sourceWords(entry.detail)} from AI models`);
    // One turn of an app's with the AI model: never what was said.
    case "models.turn": {
      const app =
        typeof entry.detail?.appName === "string"
          ? entry.detail.appName
          : "An app";
      const hasSeveralModels = Array.isArray(entry.detail?.models);
      const source = hasSeveralModels
        ? "multiple AI models"
        : typeof entry.detail?.model === "string"
          ? sourceWords(entry.detail)
          : null;
      if (!source) {
        return said(`${app} asked the AI model, but none was in use`);
      }
      if (entry.outcome !== "ok") {
        return said(
          hasSeveralModels
            ? `The AI models didn't answer ${app}`
            : `${source} didn't answer ${app}`,
        );
      }
      const tokens =
        typeof entry.detail?.tokens === "number" ? entry.detail.tokens : 0;
      const seconds =
        typeof entry.detail?.ms === "number" ? entry.detail.ms / 1000 : 0;
      return said(
        `${app} asked ${source}: ${number("en", tokens)} tokens in ${seconds.toFixed(1)} s`,
      );
    }
  }
  return null;
}
