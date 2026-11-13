import type { TileIcon } from "@meetsanctum/app-sdk";

// The icons a mood may have, as Lucide names them. They are icons a room
// section's tile may have, which the shell draws, and Moods' pages draw
// them too, so this imports nothing at run time.
export const moodIcons = [
  "sparkles",
  "armchair",
  "baby",
  "bath",
  "bed",
  "book-open",
  "briefcase",
  "cloud-moon",
  "coffee",
  "dumbbell",
  "film",
  "flame",
  "flower",
  "gamepad-2",
  "heart",
  "house",
  "moon",
  "music",
  "palette",
  "party-popper",
  "play",
  "star",
  "sun",
  "sunrise",
  "sunset",
  "trees",
  "utensils",
  "waves",
  "wine",
  "zap",
] as const satisfies readonly TileIcon[];

export type MoodIcon = (typeof moodIcons)[number];
