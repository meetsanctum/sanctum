import lakeAtSundown from "./backdrops/lake-at-sundown.webp";
import mistyForest from "./backdrops/misty-forest.webp";
import redDusk from "./backdrops/red-dusk.webp";

// The screens before the dashboard show their sheet over a moody landscape,
// blurred and darkened ahead of time so the page needs no live blur (the
// photos' credits are in backdrops/README.md). Each comes with its average
// colour, which stands in until the photo has loaded.
const backdrops = [
  { url: mistyForest, colour: "#3c3d3e" },
  { url: lakeAtSundown, colour: "#3d362a" },
  { url: redDusk, colour: "#201413" },
];

// The day picks one, so it stays while someone moves between the screens,
// even across the reloads a change of trust makes.
export function backdropOn(date: Date) {
  const day = Math.floor(
    (date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000,
  );
  return backdrops[day % backdrops.length]!;
}
