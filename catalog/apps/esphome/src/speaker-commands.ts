import { ActionError, type DriverCommand } from "@meetsanctum/app-sdk";
import { entityId, type Entity } from "esphome-client";

import type { Session } from "./connection.js";
import { describeSession } from "./session-details.js";
import { muteCommand } from "./speaker.js";
import { mediaCommandOf } from "./states.js";

export async function sendSpeakerCommand(
  session: Session,
  entity: Entity,
  command: DriverCommand,
  // Told the player an announcement went to, before it's sent.
  announced: (playerKey: number) => void,
) {
  if (command.kind === "media" && entity.type === "media_player") {
    const sent = mediaCommandOf(command.command);
    if (!sent) {
      throw new ActionError(
        "not_found",
        `${command.capability} takes no such command`,
      );
    }
    session.client.command(entityId("media_player", entity.objectId), sent);
  } else if (command.kind === "audio" && "announce" in command.command) {
    const { announcementPlayer } = describeSession(session);
    if (!announcementPlayer) {
      throw new ActionError("not_found", `${command.key} doesn't announce`);
    }
    announced(announcementPlayer.key);
    session.client.command(
      entityId("media_player", announcementPlayer.objectId),
      {
        mediaUrl: command.command.announce.url,
        announcement: true,
      },
    );
  } else if (
    command.kind === "audio" &&
    "muted" in command.command &&
    entity.type === "switch"
  ) {
    await muteCommand(session, entity, command.command.muted);
  } else {
    return false;
  }
  return true;
}
