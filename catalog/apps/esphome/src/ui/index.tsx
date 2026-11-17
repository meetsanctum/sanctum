import { defineAppUi } from "@meetsanctum/ui-sdk";

import { DevicePage } from "./device-page";
import { version } from "../../sanctum-app.json";

// ESPHome's UI, in a frame the core serves: its page in the detail of the
// devices it brings.

export default defineAppUi({
  id: "sanctum.esphome",
  version,
  pages: {},
  devicePages: { "esphome.device": DevicePage },
});
