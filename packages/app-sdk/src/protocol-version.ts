// The versions of the protocol between an app's runner and the core
// (protocol.ts), apart from it, since every app's manifest says which it
// speaks (toStaticManifest in index.ts), and protocol.ts reads index.ts.

/**
 * The runner speaks the version its app's SDK was built for; the core refuses
 * one it doesn't support. A version that only adds calls keeps what the one
 * before says, and the core goes on speaking that one too, so an app that
 * kept running through a core's update goes on with the new core. A version
 * that changes what an earlier one says, as 6 renamed the core's events,
 * raises `oldestProtocolVersion` with it: an app built before is refused and
 * runs again once it's rebuilt.
 */
// 7 lets a driver refuse adding a device whatever it asked (driver.refusals).
// 8 takes a floor wherever a place is taken: a lights place, a workflow's
// motion and light level, and a field declared with names("floor").
// 9 calls an app's uninstall hook as someone removes it.
// 10 lets a driver have a device show itself (driver.identify), and register
// whether it can.
// 11 has a driver say every device's type as it registers it, and the core
// takes it, so a driver built before is refused.
// 12 tells an app when an AI agent's device command is held back by its
// limit a minute, as `limited`.
// 13 brings media players: a driver may register the `media` kind.
// 14 brings the home's AI model: ctx.models, an answer read by its handle,
// and `no_turn` for a call outside a turn.
// 15 lets a driver hand the core a picture (ctx.blobs.put).
// 16 tells an app what the host has (ctx.host.resources).
// 17 lets adding and repairing ask once they have started (driver.addLater,
// a repair's later questions), and ends them with driver.cancelAdd and
// driver.cancelRepair.
// 18 lets an app ask for a range of ports (lan:tcp:<from>-<to>), which a core
// before would read as no port at all.
// 19 brings smart speakers' microphones: a driver may register the `audio`
// kind.
// 20 lets an app act as the household's AI assistant: ctx.ai lists the
// tools AI agents may use and calls them within a turn.
// 21 brings requests: Sanctum's Assistant answers what someone said or
// typed, with request.reply.
// 22 lets a newer request from the same device take over: the core ends the
// older one's call with `end` and refuses its later calls `turn_ended`, and a
// request carries the device's earlier exchanges.
// 23 lets a smart speaker announce from a core URL, identify the player
// it uses, and distinguish ordinary playback after the core sees a fetch.
// 24 gives an app the home clock: ctx.clock, the home's time zone and how it
// writes times.
// 25 lets a smart speaker's driver hand the core its microphone: a run it
// opens with ctx.audio.listen, its sound, and the steps the core tells it.
// 26 lets a smart speaker ask: a request says where it was asked from and,
// from a speaker, in which room, in place of the client's name, and a reply
// may say it only confirms what worked.
// 27 lets the Assistant bring the sentences a smart speaker understands, in
// its manifest.
export const protocolVersion = 27;
/** The oldest version a core still speaks. */
export const oldestProtocolVersion = 11;
