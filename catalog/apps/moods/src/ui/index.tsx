import { defineAppUi } from "@meetsanctum/ui-sdk";

import { MoodPage } from "./mood-editor";
import { MainPage } from "./pages";
import { PressesPage } from "./presses";
import { RoomMoodsPage } from "./room-moods";
import { ScheduledMoodPage } from "./scheduled-editor";
import { MoodsProvider } from "./state";
import { version } from "../../sanctum-app.json";

// Moods' UI, which the shell bundles: its main page, every room, which the
// app overview opens; its page for a room, which Edit beside the room page's
// Moods heading opens too; and the mood editor and a scheduled mood's editor
// it opens, sharing what its provider loads; and the Presses page it adds to
// a remote's detail. The shell draws rooms, their devices and Moods' section
// of moods itself.

export default defineAppUi({
  id: "sanctum.moods",
  version,
  Provider: MoodsProvider,
  pages: {
    main: MainPage,
    room: RoomMoodsPage,
    mood: MoodPage,
    scheduled: ScheduledMoodPage,
  },
  devicePages: { "moods.presses": PressesPage },
});
