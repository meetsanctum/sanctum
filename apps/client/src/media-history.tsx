import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import type { SwipePage } from "@meetsanctum/ui-sdk";
import { History } from "lucide-react";

import { productName } from "./brand";
import { Band } from "./day-and-week";
import {
  Columns,
  Notice,
  Part,
  useDayAndWeek,
  width,
  type ColumnWords,
} from "./device-history";
import { dayMs, daysOf, joinedSpans, spansOf } from "./device-history-data";
import {
  mediaSentence,
  mediaSpanText,
  playedHeadline,
  playedWeekHeadline,
} from "./media-history-data";

// A media player's History page in its detail, after its Playing and its
// Remote or Volume, from core History: the last 24 hours as a band, its
// playing as White spans, the time a player with power was on without
// playing as a faint fill and the rest as a hairline; and the last 7 days
// as a column a day of how long it played. As a light's History, it reads
// the history when it opens and every 5 minutes, and carries what the
// player is now to the end of the band meanwhile.

type Media = Extract<CapabilityInfo, { kind: "media" }>;

const playedWords: ColumnWords = {
  label: "How long it played each day",
  none: "Nothing played",
  spoken: (duration) => `played for ${duration}`,
};

/** A media player's History page. */
export function mediaHistoryPage(
  device: DeviceInfo,
  capability: Media,
): SwipePage {
  return {
    id: "history",
    label: "History",
    icon: History,
    content: (
      <MediaHistoryPage
        key={`${device.id}/${capability.id}`}
        device={device}
        capability={capability}
      />
    ),
  };
}

function MediaHistoryPage(props: { device: DeviceInfo; capability: Media }) {
  const { device, capability } = props;
  const { loaded, failed, now, live } = useDayAndWeek(device, capability);

  if (loaded && !loaded.states.kept) {
    return (
      <Notice>
        {productName} doesn't keep this device's history. You can change that in
        Settings → Devices.
      </Notice>
    );
  }
  if (failed && !loaded) {
    return <Notice>Its history can't be read right now.</Notice>;
  }

  const from = now - dayMs;
  const spans = loaded ? spansOf(loaded.states, from, now, live) : [];
  const days = loaded ? daysOf(loaded.statistics, spans, now, "playing") : [];

  return (
    <div
      data-loading={loaded ? undefined : ""}
      className={`${width} flex flex-col gap-10 transition-opacity [--history-width:480px] data-loading:opacity-0`}
    >
      <Part
        title="Last 24 hours"
        headline={playedHeadline(spans, from, now)}
        sentence={mediaSentence(
          spans,
          days,
          from,
          now,
          capability.features.power,
        )}
      >
        <Band
          spans={joinedSpans(spans).filter((span) => span.to > span.from)}
          from={from}
          to={now}
          label="Playing over the last 24 hours"
          words={mediaSpanText}
        />
      </Part>
      <Part title="Last 7 days" headline={playedWeekHeadline(days, now)}>
        <Columns days={days} now={now} words={playedWords} />
      </Part>
    </div>
  );
}
