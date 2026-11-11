// The approved artwork for known glyph and colour pairs, from the brand's
// files (assets/brand, under their own licence). App manifests still choose
// a glyph and colour; an unrecognised pair keeps the standard line icon.
import automations from "@meetsanctum/brand/app-icons/automations.webp";
import moods from "@meetsanctum/brand/app-icons/moods.webp";
import naturalLight from "@meetsanctum/brand/app-icons/natural-light.webp";
import settings from "@meetsanctum/brand/app-icons/settings.webp";
import weather from "@meetsanctum/brand/app-icons/weather.webp";
import zigbee from "@meetsanctum/brand/app-icons/zigbee.webp";

export const appArtwork = new Map([
  ["sparkles:blossom", automations],
  ["swatch-book:ember", moods],
  ["sun:sun", naturalLight],
  ["settings:graphite", settings],
  ["cloud-sun:sky", weather],
  ["radio-tower:graphite", zigbee],
]);
