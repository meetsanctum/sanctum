// Approved artwork from the brand's files (assets/brand, under their own
// licence). App-specific artwork also requires the app's ID.
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
  ["message-circle-more:iris", assistant],
  ["sparkles:blossom", automations],
  ["swatch-book:ember", moods],
  ["sun:sun", naturalLight],
  ["settings:graphite", settings],
  ["cloud-sun:sky", weather],
  ["radio-tower:graphite", zigbee],
  ["sanctum.apple-home-devices:tv:graphite", appleHomeDevices],
  ["sanctum.esphome:cpu:graphite", esphome],
  ["sanctum.ollama:cpu:iris", ollama],
]);
