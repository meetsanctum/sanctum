import type {
  AppInfo,
  AppSettings,
  SettingSchema,
  SettingValue,
} from "@meetsanctum/app-sdk";
import { Input, Switch, type LiveFeed } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useEffect, useId, useRef, useState } from "react";

import { Section } from "./components";
import { CoreError, coreJson, currentCredential } from "./core-fetch";

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
  const [values, setValues] = useState<AppSettings>();
  const [pending, setPending] = useState<PendingChange[]>([]);
  const sessionRef = useRef<ReturnType<typeof createSession> | undefined>(
    undefined,
  );
  const [problem, setProblem] = useState<string>();
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
        const title = app.settings?.properties[name]?.title ?? name;
        setProblem(
          error instanceof CoreError && error.code === "invalid_request"
            ? `${title} can’t be that. Check it and try again.`
            : "That did not work. Try again.",
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
          <SettingField
            key={name}
            setting={setting}
            value={shown[name]}
            onChange={(value) => void save(name, value)}
          />
        ))}
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>
    </Section>
  );
}

function SettingField(props: {
  setting: SettingSchema;
  value: SettingValue | undefined;
  onChange: (value: SettingValue | null) => void;
}) {
  const { setting } = props;
  if (setting.enum) return <Choice {...props} options={setting.enum} />;
  if (setting.type === "boolean") return <Toggle {...props} />;
  return <TypedField {...props} />;
}

function Hint(props: { setting: SettingSchema }) {
  return props.setting.description ? (
    <span className={label}>{props.setting.description}</span>
  ) : null;
}

function Choice(props: {
  setting: SettingSchema;
  value: SettingValue | undefined;
  options: string[];
  onChange: (value: SettingValue) => void;
}) {
  const { setting } = props;
  const name = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className={`mb-2 p-0 ${label}`}>{setting.title}</legend>
      <div className="flex flex-wrap gap-1">
        {props.options.map((option) => (
          <label
            key={option}
            className="flex h-9 cursor-pointer items-center rounded-md bg-foreground/8 px-3 text-sm font-medium has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-checked:bg-foreground has-checked:text-background"
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={props.value === option}
              onChange={() => props.onChange(option)}
              className="sr-only"
            />
            {setting.options?.[option] ?? option}
          </label>
        ))}
      </div>
      <Hint setting={setting} />
    </fieldset>
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
  onChange: (value: SettingValue | null) => void;
}) {
  const { setting, value } = props;
  const id = useId();
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
      <Hint setting={setting} />
    </div>
  );
}
