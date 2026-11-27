import type {
  DeviceInfo,
  Hearing,
  RequestLanguage,
} from "@meetsanctum/app-sdk";
import {
  Button,
  NativeSelect,
  NativeSelectOption,
  PageBar,
  PageSection,
  defineAppUi,
  icons,
  useReducedMotion,
  type PageProps,
} from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { notUnderstood, version } from "../../sanctum-app.json";
import { useAssistant } from "./use-assistant";
import {
  assignSpeakerRoom,
  examples,
  firstTry,
  hearingWords,
  languageNames,
  listeningAudio,
  mutedWords,
  speakerLine,
} from "./words";

// The Assistant's page: how speech recognition is getting on, or what to
// try once it listens; Setup, which walks through the language and a first
// command; the smart speakers, each opening its own detail, with Add a
// smart speaker; the one language the home speaks; and what you can say.
// Devices stay the shell's: the page lists them and opens them there. It's
// the household's, the same on every device.

const help = "m-0 text-[13px] leading-[18px] text-muted-foreground";
const card = "flex flex-col gap-3 rounded-xl bg-foreground/5 p-4";
const languages = Object.keys(languageNames) as RequestLanguage[];

// A bar for a step whose length nobody knows: a segment that slides across
// and starts again, moved by its transform alone, and held still in the
// middle under Reduce motion.
function StepBar(props: { label: string }) {
  const segment = useRef<HTMLSpanElement>(null);
  const isStill = useReducedMotion();
  useEffect(() => {
    if (isStill || !segment.current?.animate) return;
    // The segment is 30% of the track: from wholly before it to wholly past.
    const sliding = segment.current.animate(
      [{ transform: "translateX(-100%)" }, { transform: "translateX(334%)" }],
      { duration: 1600, easing: "ease-in-out", iterations: Infinity },
    );
    return () => sliding.cancel();
  }, [isStill]);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{props.label}</span>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={props.label}
      >
        <span
          ref={segment}
          className={`block h-full w-[30%] rounded-full bg-foreground ${isStill ? "ml-[35%]" : ""}`}
        />
      </div>
    </div>
  );
}

function Ready(props: { language: RequestLanguage }) {
  return (
    <div className="flex items-center gap-2">
      <icons.Check aria-hidden="true" className="size-4 shrink-0" />
      <span className="text-sm font-medium">
        Ready in {languageNames[props.language]}
      </span>
    </div>
  );
}

/** How hearing is doing, as a step with a bar, or ready. */
function HearingLine(props: { hearing: Hearing }) {
  const words = hearingWords(props.hearing);
  if (props.hearing.state === "ready") {
    return <Ready language={props.hearing.language} />;
  }
  return words.step ? <StepBar label={words.step} /> : null;
}

function HearingCard(props: {
  hearing: Hearing;
  room: string | null;
  /** Whether at least one speaker is online and every online speaker is muted. */
  allMuted: boolean;
  page: PageProps;
}) {
  const { hearing, page, room } = props;
  const id = useId();
  if (props.allMuted && hearing.state === "ready") {
    return <MutedCard />;
  }
  const words = hearingWords(hearing);
  return (
    <section
      aria-labelledby={id}
      aria-live="polite"
      className={`${card} gap-2.5 p-5`}
    >
      <h2 id={id} className="m-0 text-xl leading-7 font-semibold">
        {words.title}
      </h2>
      <p className="m-0 text-sm leading-5 text-muted-foreground">
        {words.help}
        {hearing.state === "ready" &&
          (room ? (
            <>
              {" "}
              Try “
              <span lang={hearing.language}>
                {firstTry(hearing.language, room)}
              </span>
              ”{hearing.language === "de" && ` at a speaker in ${room}`}.
            </>
          ) : (
            ` ${assignSpeakerRoom}`
          ))}
      </p>
      <HearingLine hearing={hearing} />
      {words.action === "addDevices" && (
        <div className="flex">
          <Button onClick={() => page.addDevices()}>Add a smart speaker</Button>
        </div>
      )}
      {words.action === "settings" && (
        <div className="flex">
          <Button variant="outline" onClick={page.openSettings}>
            Open settings
          </Button>
        </div>
      )}
    </section>
  );
}

function MutedCard() {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      aria-live="polite"
      className={`${card} gap-2.5 p-5`}
    >
      <h2 id={id} className="m-0 text-xl leading-7 font-semibold">
        {mutedWords.title}
      </h2>
      <p className="m-0 text-sm leading-5 text-muted-foreground">
        {mutedWords.help}
      </p>
    </section>
  );
}

function Row(props: {
  icon: ReactNode;
  title: string;
  line: string;
  onPress: () => void;
}) {
  return (
    <Button variant="row" size="row" type="button" onClick={props.onPress}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/8">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate text-[15px] leading-5 font-medium">
          {props.title}
        </span>
        <span className="text-[13px] leading-[18px] text-muted-foreground">
          {props.line}
        </span>
      </span>
      <icons.ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
    </Button>
  );
}

function speakerIcon(device: DeviceInfo) {
  const Icon =
    device.availability === "offline"
      ? icons.CircleMinus
      : listeningAudio(device)?.state?.muted
        ? icons.MicOff
        : icons.Speaker;
  return <Icon aria-hidden="true" className="size-4" />;
}

function Speakers(props: {
  speakers: DeviceInfo[];
  roomName: (id: string | null) => string | null;
  page: PageProps;
}) {
  return (
    <PageSection
      id="assistant-speakers"
      title="Smart speakers"
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.page.addDevices()}
        >
          Add a smart speaker
        </Button>
      }
    >
      <div className="flex flex-col">
        {props.speakers.map((device) => (
          <Row
            key={device.id}
            icon={speakerIcon(device)}
            title={device.name}
            line={speakerLine(device, props.roomName(device.roomId))}
            onPress={() => props.page.openDevice(device.id)}
          />
        ))}
      </div>
    </PageSection>
  );
}

function LanguageMenu(props: {
  id: string;
  language: RequestLanguage;
  isChoosing: boolean;
  onChoose: (language: RequestLanguage) => void;
}) {
  return (
    <NativeSelect
      aria-labelledby={props.id}
      className="w-56"
      value={props.language}
      disabled={props.isChoosing}
      onChange={(event) =>
        props.onChoose(event.currentTarget.value as RequestLanguage)
      }
    >
      {languages.map((language) => (
        <NativeSelectOption key={language} value={language} lang={language}>
          {languageNames[language]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function Examples(props: {
  language: RequestLanguage;
  room: string | null;
  withAnythingElse?: boolean;
}) {
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {examples(props.language, props.room).map(({ say, what }) => (
          <li key={say} className="flex flex-col gap-0.5">
            <span className="text-sm font-medium" lang={props.language}>
              “{say}”
            </span>
            <span className="text-[13px] leading-[18px] text-muted-foreground">
              {what}
            </span>
          </li>
        ))}
      </ul>
      {props.withAnythingElse && (
        <p className={help}>
          For anything else, it says “
          <span lang={props.language}>{notUnderstood[props.language]}</span>”
        </p>
      )}
    </>
  );
}

const firstRoom = (
  speakers: DeviceInfo[] | undefined,
  roomName: (id: string | null) => string | null,
) =>
  (speakers ?? [])
    .map((speaker) => roomName(speaker.roomId))
    .find((name) => name !== null) ?? null;

function LoadFailed(props: { onRetry: () => void }) {
  return (
    <section className={card} role="alert">
      <p className="m-0 text-sm font-medium">The Assistant didn't answer.</p>
      <div className="flex">
        <Button variant="outline" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    </section>
  );
}

function LanguageChangeError() {
  return (
    <p className={help} role="alert">
      The language didn't change. Try again.
    </p>
  );
}

function MainPage(page: PageProps) {
  const assistant = useAssistant();
  const { hearing, speakers, roomName } = assistant;
  const languageId = useId();
  const room = firstRoom(speakers, roomName);
  const [choiceFailed, setChoiceFailed] = useState(false);

  if (!hearing || !speakers) {
    return (
      <>
        <PageBar title="Assistant" />
        {assistant.hasFailed && (
          <LoadFailed onRetry={() => void assistant.reload()} />
        )}
      </>
    );
  }
  const choose = async (language: RequestLanguage) =>
    setChoiceFailed(!(await assistant.choose(language)));
  const { language, activeLanguage } = hearing;
  const onlineSpeakers = speakers.filter(
    (speaker) => speaker.availability === "online",
  );
  const allMuted =
    onlineSpeakers.length > 0 &&
    onlineSpeakers.every((speaker) => listeningAudio(speaker)?.state?.muted);
  const hearingCard = (
    <HearingCard
      hearing={hearing}
      room={room}
      allMuted={allMuted}
      page={page}
    />
  );
  // Without a smart speaker there is one thing to do: add one.
  if (hearing.state === "no_speaker") {
    return (
      <>
        <PageBar title="Assistant" />
        {hearingCard}
      </>
    );
  }
  return (
    <>
      <PageBar title="Assistant" />
      {hearingCard}
      <PageSection id="assistant-setup" title="Setup">
        <Row
          icon={<icons.ListChecks aria-hidden="true" className="size-4" />}
          title="Set up step by step"
          line="Choose the language and try your first command"
          onPress={() => page.open("setup")}
        />
      </PageSection>
      {speakers.length > 0 && (
        <Speakers speakers={speakers} roomName={roomName} page={page} />
      )}
      <section aria-labelledby={languageId} className="flex flex-col gap-2">
        <h2
          id={languageId}
          className="m-0 text-[15px] leading-[22px] font-medium"
        >
          Language
        </h2>
        <div className={card}>
          <LanguageMenu
            id={languageId}
            language={language}
            isChoosing={assistant.isChoosing}
            onChoose={(next) => void choose(next)}
          />
          <p className={help}>
            It listens and replies in one language. Switching takes a few
            minutes.
          </p>
          {choiceFailed && <LanguageChangeError />}
        </div>
      </section>
      <PageSection id="assistant-say" title="What you can say">
        <div className="flex flex-col gap-3 px-2.5 py-2">
          <Examples
            language={activeLanguage ?? language}
            room={room}
            withAnythingElse
          />
        </div>
      </PageSection>
    </>
  );
}

// Setup, opened from the page whenever someone wants it: the language, then
// a first command to try. Cancel or Done goes back to the page.
function SetupPage(page: PageProps) {
  const assistant = useAssistant();
  const { hearing, speakers, roomName } = assistant;
  const [step, setStep] = useState<1 | 2>(page.params.step === "try" ? 2 : 1);
  const [chosen, setChosen] = useState<RequestLanguage>();
  const [choiceFailed, setChoiceFailed] = useState(false);
  const titleId = useId();
  const room = firstRoom(speakers, roomName);
  const language = chosen ?? hearing?.language ?? "en";
  const tryLanguage = hearing?.activeLanguage ?? hearing?.language;

  const next = async () => {
    const changed = await assistant.choose(language);
    setChoiceFailed(!changed);
    if (changed) setStep(2);
  };

  if (step === 1) {
    return (
      <>
        <PageBar
          title="Setup"
          actions={[
            { id: "cancel", label: "Cancel", onPress: page.back },
            {
              id: "continue",
              label: "Continue",
              primary: true,
              disabled: !hearing || assistant.isChoosing,
              onPress: () => void next(),
            },
          ]}
        />
        <section aria-labelledby={titleId} className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <p className="m-0 text-[13px] font-medium text-muted-foreground">
              Step 1 of 2
            </p>
            <h2
              id={titleId}
              className="m-0 text-[17px] leading-6 font-semibold"
            >
              Which language do you speak to it?
            </h2>
          </div>
          <LanguageMenu
            id={titleId}
            language={language}
            isChoosing={assistant.isChoosing}
            onChoose={setChosen}
          />
          {choiceFailed && <LanguageChangeError />}
          <div className={card}>
            <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">
              Things you can say
            </h3>
            <Examples language={language} room={room} />
          </div>
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            Speech recognition runs in your home, so nothing you say leaves it.
          </p>
        </section>
      </>
    );
  }
  return (
    <>
      <PageBar
        title="Setup"
        actions={[
          { id: "back", label: "Back", onPress: () => setStep(1) },
          { id: "done", label: "Done", primary: true, onPress: page.back },
        ]}
      />
      <section aria-labelledby={titleId} className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="m-0 text-[13px] font-medium text-muted-foreground">
            Step 2 of 2
          </p>
          <h2 id={titleId} className="m-0 text-[17px] leading-6 font-semibold">
            Try it
          </h2>
        </div>
        {tryLanguage && room && (
          <>
            <p
              className="m-0 text-xl leading-7 font-semibold"
              lang={tryLanguage}
            >
              “{firstTry(tryLanguage, room)}”
            </p>
            <p className="m-0 text-sm leading-5 text-muted-foreground">
              {tryLanguage === "de"
                ? `At a speaker in ${room}, say its wake word first.`
                : "Say your speaker's wake word first."}
            </p>
          </>
        )}
        {speakers && speakers.length > 0 && !room && (
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            {assignSpeakerRoom}
          </p>
        )}
        {hearing && (
          <div aria-live="polite">
            <HearingLine hearing={hearing} />
          </div>
        )}
        {speakers && speakers.length > 0 ? (
          <PageSection
            id="assistant-setup-speakers"
            title="Your smart speakers"
          >
            <div className="flex flex-col">
              {speakers.map((device) => (
                <Row
                  key={device.id}
                  icon={speakerIcon(device)}
                  title={device.name}
                  line={speakerLine(device, roomName(device.roomId))}
                  onPress={() => page.openDevice(device.id)}
                />
              ))}
            </div>
          </PageSection>
        ) : (
          <div className={card}>
            <p className="m-0 text-sm font-medium">No smart speaker yet</p>
            <div className="flex">
              <Button
                variant="outline"
                onClick={() => page.addDevices({ step: "try" })}
              >
                Add a smart speaker
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

export default defineAppUi({
  id: "sanctum.assistant",
  version,
  pages: { main: MainPage, setup: SetupPage },
});
