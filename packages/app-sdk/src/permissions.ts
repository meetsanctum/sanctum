import { z } from "zod";

// What an app asks for: each permission with its reason, one short sentence
// in the app's own words, and whether the app cannot work without it. The
// core keeps what the household granted, the app's grants, and the app reads
// them with ctx.permissions.list(); its settings page shows each permission
// with its reason.
//
// One the app needs is granted when the core first sees it ask, and so is
// an optional one its out-of-the-box behaviour needs (startsOn), such as
// Moods' presses, so a new remote switches its room's lights from the
// first press. Every other optional permission starts off, until the
// app's page asks for it where it is used (client.ask()); `asked` says
// when, for its settings page.

/** A reason stays short enough to show whole on a phone. */
export const reasonMaxLength = 80;

/** When it is asked stays as short as a reason. */
export const askedMaxLength = 60;

export const permissionRequestSchema = z
  .strictObject({
    id: z.string().min(1),
    reason: z.string().trim().min(1).max(reasonMaxLength),
    // Granted when the app is added; switching it off pauses the app.
    needed: z.boolean().optional(),
    // When the app asks for it while it is off, as its settings page shows
    // it after "Asked": "when you choose what a remote's press does", or
    // "with presses and motion" for one asked together with others.
    asked: z
      .string()
      .trim()
      .max(askedMaxLength)
      .regex(
        /^(when|with) [^\r\n\u2028\u2029]+$/,
        'say when, such as "when you turn on lights for motion"',
      )
      .optional(),
    // Granted when first seen, for an optional permission the app's
    // out-of-the-box behaviour needs.
    startsOn: z.boolean().optional(),
  })
  .refine((request) => !request.needed || request.asked === undefined, {
    message: "a permission the app needs is never asked: it is granted",
    path: ["asked"],
  })
  .refine((request) => !request.needed || request.startsOn === undefined, {
    message: "a permission the app needs is granted already",
    path: ["startsOn"],
  });

/** One permission an app asks for, as its definition declares it. */
export type PermissionRequest = z.input<typeof permissionRequestSchema>;

/** One permission an app asks for, as its static manifest and clients carry it. */
export type PermissionInfo = {
  id: string;
  reason: string;
  needed: boolean;
  /** When the app asks for it while it is off, such as "when you …". */
  asked: string | null;
  /** Granted when first seen, though the app does without it. */
  startsOn: boolean;
};

/** The ids of the permissions an app asks for. */
export function permissionIds(requests: readonly { id: string }[]) {
  return requests.map((request) => request.id);
}

export function permissionInfo(request: PermissionRequest): PermissionInfo {
  return {
    id: request.id,
    reason: request.reason.trim(),
    needed: request.needed ?? false,
    asked: request.asked?.trim() ?? null,
    startsOn: request.startsOn ?? false,
  };
}

/** Whether the core grants it when it first sees the app ask for it. */
export function grantedAtFirst(
  request: Pick<PermissionRequest, "needed" | "startsOn">,
) {
  return request.needed === true || request.startsOn === true;
}

/**
 * What is wrong with the optional permissions a workflow piece needs
 * (`needs`, which the workflow editor asks for when someone adds it): one
 * the app does not ask for, or needs, so it is never asked.
 */
export function needsProblems(
  needs: readonly string[] | undefined,
  requests: readonly PermissionRequest[],
): string[] {
  if (needs === undefined) return [];
  if (!Array.isArray(needs)) return ["its needs must be a list of permissions"];
  return needs.flatMap((id) => {
    const request = requests.find((each) => each.id === id);
    if (!request) return [`it needs ${id}, which the app does not ask for`];
    return request.needed
      ? [`it needs ${id}, which the app needs already: list only optional ones`]
      : [];
  });
}

/**
 * Whether an app runs: paused while a permission it needs is switched off,
 * running again once every one is back on; stopped when it did not stop
 * cleanly, until Sanctum restarts, since its code may still be running.
 */
export type AppState =
  | "running"
  | "paused"
  | "stopped"
  // Someone turned it off in its settings: what it adds is hidden, a driver's
  // devices are offline and its data stays, until someone turns it on.
  | "off"
  // An app in its own container: on its way up; saying what it waits for;
  // after a failure, on its way back; and given up on after too many
  // failures, until someone restarts it.
  | "starting"
  | "waiting"
  | "restarting"
  | "failed";

/** What stopped an app in its own container last. */
export type AppFailure = "crashed" | "out_of_memory" | "hung" | "failed_start";

/** How an app's update stands, for what clients say of it. */
export type AppRunUpdate =
  | { stage: "updating"; to: string }
  | { stage: "goingBack"; to: string }
  // On the old version, because `from` didn't start, or wasn't ready to, in which
  // case it tries again later, or because someone chose to go back from it.
  | { stage: "wentBack"; from: string; triesAgain: boolean; chosen?: true };

/** What going back from an app's last update would return to. */
export type AppGoBack = {
  /** The kept copy a confirmation applies to. */
  id: string;
  version: string;
  /** When that update began, which is how old the data it returns to is. */
  since: string;
};

/** How an app in its own container is running now, for its settings. */
export type AppRunning = {
  /** What it holds. Null while it isn't running, or the home can't tell. */
  memoryBytes: number | null;
  /** A percentage of one core. Null while it isn't running, or the home can't tell. */
  processor: number | null;
  /** What its data takes on the disk. */
  dataBytes: number | null;
  restarts: {
    /** How many in the last 10 minutes. */
    recent: number;
    /** The last, since Sanctum last started and its failures were last forgotten. */
    last?: { at: string; failure: AppFailure };
  };
};

export type AppRun = {
  /** When it reached its state. */
  since: string;
  /** Its first start has not returned or been interrupted. */
  isFirstStart?: true;
  /** What it waits for. */
  waitingFor?: string;
  /** How often it has failed lately, and what stopped it last. */
  failures?: number;
  lastFailure?: AppFailure;
  /**
   * It went down under 30 s ago, so Home and its pages stay as they were: most
   * restarts end sooner, and nobody needs to notice one that fixes itself. The
   * core says so, and when it's over, so no client goes by its own clock.
   */
  quiet?: true;
  /** It has been waiting long enough to tell someone what for. */
  attention?: true;
  /** An update under way, or the one it went back from. */
  update?: AppRunUpdate;
};

/** The permissions an app needs that are switched off, which pause it. */
export function pausedBy(
  requests: readonly Pick<PermissionRequest, "id" | "needed">[],
  granted: readonly string[],
) {
  return requests
    .filter((request) => request.needed && !granted.includes(request.id))
    .map((request) => request.id);
}
