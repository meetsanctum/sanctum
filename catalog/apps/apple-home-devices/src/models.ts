// What a box is, from the model AirPlay announces ("AppleTV14,1"): an Apple
// TV this app adds, a HomePod it lists but can't pair, as it shows no code,
// or something else that speaks AirPlay, such as a Mac, which it leaves out.

export type BoxKind = "tv" | "homepod";

const names: Record<string, string> = {
  "AppleTV5,3": "Apple TV HD",
  "AppleTV6,2": "Apple TV 4K",
  "AppleTV11,1": "Apple TV 4K (2nd generation)",
  "AppleTV14,1": "Apple TV 4K (3rd generation)",
  "AudioAccessory1,1": "HomePod",
  "AudioAccessory1,2": "HomePod",
  "AudioAccessory5,1": "HomePod mini",
  "AudioAccessory6,1": "HomePod (2nd generation)",
};

// From the Apple TV HD on, Apple TVs run tvOS, which has Companion; older
// ones run a system this app doesn't speak.
const firstTvos = 5;

/** What kind of box a model is, or null for one this app leaves out. */
export function kindOf(model: string): BoxKind | null {
  const tv = /^AppleTV(\d+),\d+$/.exec(model);
  if (tv) return Number(tv[1]) >= firstTvos ? "tv" : null;
  if (/^AudioAccessory\d+,\d+$/.test(model)) return "homepod";
  return null;
}

/** The model's name, as Apple sells it. */
export function modelName(model: string): string {
  return names[model] ?? (kindOf(model) === "homepod" ? "HomePod" : "Apple TV");
}
