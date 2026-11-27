// The approved artwork for known glyph and colour pairs, from the brand's
// files (assets/brand, under their own licence). App manifests still choose
// a glyph and colour; an unrecognised pair keeps the standard line icon.
import appleHomeDevices from "@meetsanctum/brand/app-icons/apple-home-devices.webp";
import assistant from "@meetsanctum/brand/app-icons/assistant.webp";
import automations from "@meetsanctum/brand/app-icons/automations.webp";
import esphome from "@meetsanctum/brand/app-icons/esphome.webp";
import moods from "@meetsanctum/brand/app-icons/moods.webp";
import naturalLight from "@meetsanctum/brand/app-icons/natural-light.webp";
import ollama from "@meetsanctum/brand/app-icons/ollama.webp";
import settings from "@meetsanctum/brand/app-icons/settings.webp";
import weather from "@meetsanctum/brand/app-icons/weather.webp";
import zigbee from "@meetsanctum/brand/app-icons/zigbee.webp";

export const appArtwork = new Map([
  ["tv:graphite", appleHomeDevices],
  ["message-circle-more:iris", assistant],
  ["sparkles:blossom", automations],
  ["cpu:graphite", esphome],
  ["swatch-book:ember", moods],
  ["sun:sun", naturalLight],
  ["cpu:iris", ollama],
  ["settings:graphite", settings],
  ["cloud-sun:sky", weather],
  ["radio-tower:graphite", zigbee],
]);
