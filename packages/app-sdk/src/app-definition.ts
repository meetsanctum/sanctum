import type { z } from "zod";

import type { AppManifestFields } from "./app-manifest.js";
import type { AppContext, RequestContext } from "./context.js";
import type { DriverCancelAdd, DriverCancelRepair } from "./device-asking.js";
import type { DevicePageDefinition } from "./device-pages.js";
import type { DriverCommand, DriverMove } from "./devices.js";
import type { Provides } from "./entities.js";
import type {
  DriverProblem,
  DriverQuestion,
  DriverRepair,
  DriverRepairResult,
} from "./device-problems.js";
import type { DriverDiscovery } from "./discovery.js";
import type { DriverAdd, DriverAddResult } from "./found-devices.js";
import type { DriverDevice } from "./firmware.js";
import type { DriverRemoval } from "./pairing.js";
import type { AssistantRequestCall } from "./requests.js";
import type { AssistantSentences, NotUnderstood } from "./sentences.js";
import type { RoomSectionDefinition } from "./room-sections.js";
import type { TriggerDefinition } from "./workflows.js";
import type {
  ActionDefinition,
  EventDefinition,
  StartInfo,
  StopInfo,
} from "./index.js";

/**
 * What an app brings to the home, declared so the core and its editors can
 * list it without running the app: its entity types, widgets and room
 * section, and its workflow pieces.
 */
export interface AppProvides extends Provides {
  /** Its part of every room's page, at most one (room-sections.ts). */
  readonly roomSections?: readonly RoomSectionDefinition[];
  /** Pages it adds to the detail of devices of some kinds (device-pages.ts). */
  readonly devicePages?: readonly DevicePageDefinition[];
  readonly triggers?: readonly TriggerDefinition[];
  /** Read actions that answer true or false. */
  readonly conditions?: readonly ActionDefinition[];
  readonly steps?: readonly ActionDefinition[];
}

export interface AppDefinition extends AppManifestFields {
  readonly actions: readonly ActionDefinition[];
  readonly events: readonly EventDefinition[];
  /**
   * Its preferences, as a zod object (settings.ts): the core keeps what
   * the household chooses, Settings → Apps → the app shows them as a form, and the
   * app reads them with ctx.settings.get().
   */
  readonly settings?: z.ZodObject;
  /**
   * What it brings to the home: its entities' types and widgets, and its
   * workflow pieces.
   */
  readonly provides?: AppProvides;
  /**
   * Runs when the core starts the app, with a context that lasts until
   * `stop`, acting as the app itself. A driver opens its connection here
   * and reports its devices through this context. An app that runs apart may
   * throw NotReady to be tried again later.
   */
  start?(ctx: AppContext, info: StartInfo): Promise<void>;
  /**
   * Runs instead of `start` when the core restarted while the app ran, as for
   * an update of the core. With it, the app goes on through the restart: what
   * its start set going keeps running, though its calls into the core fail
   * while no core is there, and the events it follows come again. It catches
   * up with what may have changed, from one snapshot of the home as a start
   * reads, through the same context its start was given. Without it, the app
   * stops as the core goes and starts again for the next. One that fails, or
   * throws NotReady, is stopped.
   */
  resume?(ctx: AppContext, info: StartInfo): Promise<void>;
  /** Runs when the core stops or removes the app. */
  stop?(ctx: AppContext, info: StopInfo): Promise<void>;
  /**
   * Runs when someone removes the app, while it still runs, before it stops:
   * the last tidying outside the home, such as letting a cloud service know
   * it's gone. It has 30 seconds, acting as the app with the permissions it
   * holds, and may run again for the same removal. The removal goes on
   * whether it ends or not. Its own data stays a while, so adding it back
   * brings back what it had.
   */
  uninstall?(ctx: AppContext): Promise<void>;
  /**
   * Sanctum's Assistant only: answers a request someone said or typed, within
   * the turn the core opened for it, with `request.reply()`. The core refuses
   * it from any other app.
   */
  requests?(ctx: RequestContext, request: AssistantRequestCall): Promise<void>;
  /**
   * Sanctum's Assistant only: the sentences it understands when someone
   * speaks to a smart speaker, by language, which speech recognition learns
   * with the home's names filled in (sentences.ts).
   */
  readonly sentences?: AssistantSentences;
  /**
   * Sanctum's Assistant only: what a smart speaker says for speech outside
   * its sentences, in each language it has sentences for. Without one,
   * the speaker says nothing.
   */
  readonly notUnderstood?: NotUnderstood;
  /**
   * A driver app's side of the Drivers contract: the core hands it every
   * command for its own devices, as the actor behind the command. It
   * resolves once the command is on its way; the device's report confirms
   * it. An unknown device is refused with ActionError("not_found").
   */
  readonly driver?: {
    command(ctx: AppContext, command: DriverCommand): Promise<void>;
    /**
     * Moves one of its lights' brightness up or down at a rate until a stop,
     * or stops it, as while a remote's button is held, resolving once the
     * move is on its way. The light's reports say where it got to. A driver
     * without it has its lights left alone by holds.
     */
    move?(ctx: AppContext, move: DriverMove): Promise<void>;
    /**
     * Lets new devices join the driver's network while someone adds
     * devices: `open` for `seconds`, answering until when, and `close` to
     * stop. Meanwhile the driver says how each device that joins is getting
     * on (ctx.devices.joining) and registers it once it can.
     */
    readonly pairing?: {
      open(
        ctx: AppContext,
        request: { seconds: number },
      ): Promise<{ until: string | null }>;
      close(ctx: AppContext): Promise<void>;
    };
    /**
     * Takes one of its devices off its network, resolving once it has gone;
     * the core then forgets it. A device it no longer has is gone already.
     */
    remove?(ctx: AppContext, removal: DriverRemoval): Promise<void>;
    /**
     * Updates its devices' firmware, when someone asks. `check` asks whether
     * an update is available and resolves once the driver has said
     * (ctx.devices.firmware); `update` starts one, or has a sleeping device
     * start it when it wakes, and resolves once it is on its way; `stop`
     * ends one under way or waiting, and the device keeps what it runs. The
     * driver says how each goes as it learns it.
     */
    readonly firmware?: {
      check(ctx: AppContext, device: DriverDevice): Promise<void>;
      update(ctx: AppContext, device: DriverDevice): Promise<void>;
      stop(ctx: AppContext, device: DriverDevice): Promise<void>;
    };
    /**
     * Asks one of its devices how it is now, resolving once asked: the
     * device's report answers (Check connection).
     */
    probe?(ctx: AppContext, device: DriverDevice): Promise<void>;
    /**
     * Has one of its devices show itself, resolving once asked: a light
     * blinks, or a sensor flashes its own light, so a person can see which
     * one it is (Blink). Only a device registered with `identify` is asked.
     */
    identify?(ctx: AppContext, device: DriverDevice): Promise<void>;
    /**
     * What can be wrong with its devices, by id, in its own words, which it
     * names for a device with ctx.devices.problem (device-problems.ts).
     */
    readonly problems?: Readonly<Record<string, DriverProblem>>;
    /** What adding or repairing one of its devices may ask, by id. */
    readonly questions?: Readonly<Record<string, DriverQuestion>>;
    /**
     * What adding a device it found may ask once it has started, by id
     * among its questions, such as a code a TV shows only once pairing
     * begins (device-asking.ts). A driver that declares any has cancelAdd.
     */
    readonly addLater?: readonly string[];
    /**
     * When adding asks once started, it asks each addLater question in
     * order, one per step. A retry may ask the same question again.
     */
    readonly addLaterInOrder?: true;
    /**
     * Why it may refuse adding a device it found, whatever adding it asks,
     * by id, in the words the shell then shows with the device: "It stopped
     * waiting for a key…".
     */
    readonly refusals?: Readonly<Record<string, string>>;
    /**
     * Sets one of its devices right, with the answers to what its problem's
     * repair asks, resolving once done or with the answer it refuses.
     */
    repair?(ctx: AppContext, repair: DriverRepair): Promise<DriverRepairResult>;
    /**
     * Ends repairing one of its devices that asked once it had started, as
     * someone cancels, its time runs out or the device is removed: it closes
     * whatever it opened for that attempt, such as a pairing connection, and
     * resolves once it has. It is there exactly when a problem's repair has
     * later questions.
     */
    cancelRepair?(ctx: AppContext, cancel: DriverCancelRepair): Promise<void>;
    /**
     * What it finds on the home's network, of the services it holds
     * discover:mdns:<service> for: every sighting as it starts, then each one
     * found, changed or lost, in order (discovery.ts). It resolves once it
     * has taken them in.
     */
    discovered?(ctx: AppContext, discovery: DriverDiscovery): Promise<void>;
    /**
     * Adds one of the devices it found (ctx.devices.found), with the answers
     * to what adding it asks: it registers the device, then resolves, or
     * resolves with the answer it refuses, or with what it asks next of its
     * addLater questions, keeping what it opened for the attempt until the
     * next answer. The core gives each call a minute.
     */
    add?(ctx: AppContext, add: DriverAdd): Promise<DriverAddResult>;
    /**
     * Ends adding a device that asked once it had started, as someone
     * cancels, its time runs out or a newer attempt starts: it closes
     * whatever it opened for that attempt, such as a pairing connection, and
     * resolves once it has. It is there exactly when addLater is.
     */
    cancelAdd?(ctx: AppContext, cancel: DriverCancelAdd): Promise<void>;
  };
}
