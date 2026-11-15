import { defineAppUi } from "@meetsanctum/ui-sdk";

import { DevicePage } from "./device-page";
import { version } from "../../sanctum-app.json";

// ESPHome's UI, which the shell bundles: its page in the detail of the
// devices it brings.

export default defineAppUi({
  id: "sanctum.esphome",
  version,
  pages: {},
  devicePages: { "esphome.device": DevicePage },
});
