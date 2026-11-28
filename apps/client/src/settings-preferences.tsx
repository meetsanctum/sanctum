import type {
  AppInfo,
  AppSettings,
  SettingSchema,
  SettingValue,
} from "@meetsanctum/app-sdk";
import {
  Input,
  Problem,
  SegmentedControl,
  Switch,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useEffect, useId, useRef, useState } from "react";

import { SheetProblem } from "./auth/sheet";
import { Section } from "./components";
import { CoreError, coreJson, currentCredential } from "./core-fetch";
import { problemReason } from "./device-parts";

// Settings → Apps → the app: its preferences, a form generated from its
// settings schema. They are the household's, so everyone sees and changes
// them, on every device, and the app follows them everywhere. Each changes
// as it is changed: a choice or a switch at once, a number or text once it
// is left or Enter is pressed; clearing a number or text gives back its
// default.

const label = "text-[13px] leading-[18px] font-medium text-muted-foreground";
const field =
  "h-10 bg-background text-[15px] text-foreground placeholder:text-muted-foreground md:text-[15px]";

const settingsPath = (appId: string) =>
  `/api/apps/${encodeURIComponent(appId)}/settings`;

// A change on its way to the core. Pending changes show over the
// values the core confirmed, so a refusal undoes only its own change.
type PendingChange = { name: string; value: SettingValue | null };

// One app's form while it is open. Changes go to the core one at a time, in
// order; the revision moves on with each live message and each change, so
// an answer from before either never replaces what came after.
const createSession = () => ({
  isCurrent: true,
  revision: 0,
  request: 0,
  queue: Promise.resolve(),
});

export function PreferencesSection(props: { app: AppInfo; live: LiveFeed }) {
  const { app, live } = props;
  const problemId = useId();
  const [values, setValues] = useState<AppSettings>();
  const [pending, setPending] = useState<PendingChange[]>([]);
  const sessionRef = useRef<ReturnType<typeof createSession> | undefined>(
    undefined,
  );
  // What went wrong with a change, shown under its setting: a value the
  // app refused, said as the field's own line, or a change that didn't
  // reach it.
  const [problem, setProblem] = useState<{
    name: string;
    refused?: string;
    failed?: string;
  }>();
  const properties = Object.entries(app.settings?.properties ?? {});

  useEffect(() => {
    const session = createSession();
    sessionRef.current = session;
    setValues(undefined);
    setPending([]);
    setProblem(undefined);
    const load = async () => {
      const request = ++session.request;
      const startedAt = session.revision;
      try {
        const answer = await coreJson<AppSettings>(settingsPath(app.id));
        if (
          session.isCurrent &&
          request === session.request &&
          startedAt === session.revision
        ) {
          setValues(answer);
        }
      } catch {
        // The shell retries when the connection returns.
      }
    };
    // Someone else's change, from another device.
    const stop = live.subscribe({
      refresh: () => void load(),
      message(message) {
        if (message.type === "settings" && message.app === app.id) {
          session.revision += 1;
          setValues(message.settings);
        }
      },
    });
    void load();
    return () => {
      session.isCurrent = false;
      stop();
    };
  }, [app.id, live]);

  if (properties.length === 0 || !values) return null;

  const shown = { ...values };
  for (const { name, value } of pending) {
    if (value === null) {
      const fallback = app.settings?.properties[name]?.default;
      if (fallback === undefined) delete shown[name];
      else shown[name] = fallback;
    } else shown[name] = value;
  }

  const save = (name: string, value: SettingValue | null) => {
    const session = sessionRef.current!;
    const credential = currentCredential();
    const change = { name, value };
    setPending((current) => [...current, change]);
    setProblem(undefined);
    session.queue = session.queue.then(async () => {
      // Finish queued edits after Done, but never send them to another
      // home or as another signed-in person.
      if (currentCredential() !== credential) return;
      const startedAt = ++session.revision;
      try {
        const answer = await coreJson<AppSettings>(
          `${settingsPath(app.id)}/update`,
          {
            method: "POST",
            json: { [name]: value },
          },
        );
        if (session.isCurrent && startedAt === session.revision)
          setValues(answer);
      } catch (error) {
        if (!session.isCurrent) return;
        setProblem(
          error instanceof CoreError && error.code === "invalid_request"
            ? {
                name,
                refused: refusedText(
                  app.name,
                  app.settings?.properties[name],
                  value,
                ),
              }
            : { name, failed: problemReason(error) },
        );
      } finally {
        session.revision += 1;
        if (session.isCurrent)
          setPending((current) => current.filter((each) => each !== change));
      }
    });
  };

  return (
    <Section id="settings-preferences" title="Preferences">
      <div className="flex flex-col gap-4">
        {properties.map(([name, setting]) => (
          <div key={name} className="flex flex-col gap-2">
            <SettingField
              setting={setting}
              value={shown[name]}
              problemId={
                problem?.name === name && problem.refused
                  ? problemId
                  : undefined
              }
              onChange={(value) => void save(name, value)}
            />
            {problem?.name === name && problem.refused && (
              <SheetProblem id={problemId}>{problem.refused}</SheetProblem>
            )}
            {problem?.name === name && problem.failed && (
              <Problem title={`${setting.title} wasn't changed`}>
                {problem.failed}
              </Problem>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// What to change in a value the app refused: its numeric limits, when
// declared, or the value itself.
function refusedText(
  appName: string,
  setting: SettingSchema | undefined,
  value: SettingValue | null,
) {
  const { minimum, maximum, multipleOf } = setting ?? {};
  if (multipleOf !== undefined) {
    const amount = `a multiple of ${multipleOf}`;
    if (minimum !== undefined && maximum !== undefined)
      return `Use ${amount} from ${minimum} to ${maximum}.`;
    if (minimum !== undefined)
      return `Use ${amount} that is at least ${minimum}.`;
    if (maximum !== undefined)
      return `Use ${amount} that is at most ${maximum}.`;
    return `Use ${amount}.`;
  }
  if (minimum !== undefined && maximum !== undefined)
    return `Use a number from ${minimum} to ${maximum}.`;
  if (minimum !== undefined) return `Use ${minimum} or more.`;
  if (maximum !== undefined) return `Use ${maximum} or less.`;
  const shown =
    value === null ? "that" : typeof value === "string" ? `“${value}”` : value;
  return `${appName} can't use ${shown}. Try a different one.`;
}

function SettingField(props: {
  setting: SettingSchema;
  value: SettingValue | undefined;
  problemId?: string;
  onChange: (value: SettingValue | null) => void;
}) {
  const { setting } = props;
  if (setting.enum) return <Choice {...props} options={setting.enum} />;
  if (setting.type === "boolean") return <Toggle {...props} />;
  return <TypedField {...props} />;
}

function Hint(props: { setting: SettingSchema; id?: string }) {
  return props.setting.description ? (
    <span id={props.id} className={label}>
      {props.setting.description}
    </span>
  ) : null;
}

// A few choices side by side, the one in effect chosen; long labels wrap.
function Choice(props: {
  setting: SettingSchema;
  value: SettingValue | undefined;
  options: string[];
  onChange: (value: SettingValue) => void;
}) {
  const { setting } = props;
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span id={`${id}-label`} className={label}>
        {setting.title}
      </span>
      <SegmentedControl
        labelledBy={`${id}-label`}
        describedBy={setting.description ? `${id}-hint` : undefined}
        options={props.options.map((option) => ({
          value: option,
          label: setting.options?.[option] ?? option,
        }))}
        value={typeof props.value === "string" ? props.value : undefined}
        onValueChange={props.onChange}
        wraps
        className="self-start"
      />
      <Hint setting={setting} id={`${id}-hint`} />
    </div>
  );
}

function Toggle(props: {
  setting: SettingSchema;
  value: SettingValue | undefined;
  onChange: (value: SettingValue) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {props.setting.title}
        </label>
        <Switch
          id={id}
          checked={props.value === true}
          onCheckedChange={(checked) => props.onChange(checked)}
        />
      </div>
      <Hint setting={props.setting} />
    </div>
  );
}

// A number or a line of text, saved once it is left or Enter is pressed.
function TypedField(props: {
  setting: SettingSchema;
  value: SettingValue | undefined;
  problemId?: string;
  onChange: (value: SettingValue | null) => void;
}) {
  const { setting, value, problemId } = props;
  const id = useId();
  const hintId = setting.description ? `${id}-hint` : undefined;
  const shown = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const isNumber = setting.type === "number" || setting.type === "integer";

  const commit = () => {
    const text = draft.trim();
    if (text === shown) return;
    if (!text) {
      setDraft(setting.default === undefined ? "" : String(setting.default));
      return props.onChange(null);
    }
    if (!isNumber) return props.onChange(text);
    const number = Number(text.replace(",", "."));
    if (Number.isFinite(number)) props.onChange(number);
    else setDraft(shown);
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={label}>
        {setting.title}
      </label>
      <Input
        id={id}
        aria-invalid={problemId ? true : undefined}
        aria-describedby={
          [hintId, problemId].filter(Boolean).join(" ") || undefined
        }
        value={draft}
        inputMode={
          !isNumber
            ? undefined
            : setting.type === "integer"
              ? "numeric"
              : "decimal"
        }
        maxLength={setting.maxLength}
        placeholder={
          setting.default === undefined ? undefined : String(setting.default)
        }
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        className={cn(field, isNumber && "max-w-32 tabular-nums")}
      />
      <Hint setting={setting} id={hintId} />
    </div>
  );
}
