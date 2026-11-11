import type { Platform } from "@meetsanctum/auth-protocol";

// How each platform a client runs on is named to people.
export const platformNames: Record<Platform, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  web: "Web browser",
};
