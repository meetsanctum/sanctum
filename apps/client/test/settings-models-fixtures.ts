import type { ModelSourceInfo } from "@meetsanctum/app-sdk";

export const now = new Date("2026-11-23T12:00:00Z");
export const mac: ModelSourceInfo = {
  id: "mac",
  kind: "computer",
  model: "qwen3:8b",
  modelName: "Qwen3 8B",
  computer: "Office Mac",
  address: "192.168.1.40:11434",
  inUse: true,
  check: { at: "2026-11-23T11:55:00Z", outcome: "answered", firstWordMs: 2100 },
  tokens: { today: 46, month: 1_046 },
};
export const router: ModelSourceInfo = {
  id: "router",
  kind: "openrouter",
  model: "openai/gpt-5-mini",
  modelName: "OpenAI: GPT-5 Mini",
  keyEnd: "4f2a",
  inUse: false,
  check: { at: "2026-11-23T11:00:00Z", outcome: "noTool", firstWordMs: 800 },
  tokens: { today: 0, month: 18_400 },
};
