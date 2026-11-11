import type {
  EntityInfo,
  Forecast,
  TemperatureUnit,
  WidgetContent,
} from "@meetsanctum/app-sdk";
import { useAppClient, useTemperatureUnit } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

// What Weather brings to the home, as its page shows it: its own card and
// forecast, read once and then followed live, and the unit the home shows
// temperatures in.

export type WeatherView = {
  loaded: boolean;
  unit: TemperatureUnit;
  /** What its card says, which the shell draws. */
  card: WidgetContent | null;
  forecast: Forecast | null;
};

export function useWeather(): WeatherView {
  const client = useAppClient();
  const unit = useTemperatureUnit();
  const [entities, setEntities] = useState<EntityInfo[]>();

  useEffect(() => {
    let isCurrent = true;
    let revision = 0;
    let request = 0;
    const load = async () => {
      const currentRequest = ++request;
      const startedAt = revision;
      try {
        const list = await client.entities();
        if (!isCurrent || currentRequest !== request) return;
        if (startedAt !== revision) {
          // A live event arrived after this snapshot was requested. Read
          // again rather than overwrite it with an older HTTP response.
          void load();
          return;
        }
        setEntities(list);
      } catch {
        // The shell retries when the connection is restored.
      }
    };
    const stop = client.subscribe({
      refresh: () => void load(),
      message(message) {
        if (message.type !== "entity" || message.app !== client.app.id) {
          return;
        }
        revision += 1;
        setEntities((list) => {
          const others = (list ?? []).filter(
            (each) => each.key !== message.key,
          );
          return message.entity ? [...others, message.entity] : others;
        });
      },
    });
    void load();
    return () => {
      isCurrent = false;
      stop();
    };
  }, [client]);

  const own = (type: string) =>
    entities?.find((each) => each.app === client.app.id && each.type === type)
      ?.state ?? null;
  return {
    // Until the unit is known, no temperature shows in the other one.
    loaded: entities !== undefined && unit !== undefined,
    unit: unit ?? "celsius",
    card: own("weather.card") as WidgetContent | null,
    forecast: own("weather.forecast") as Forecast | null,
  };
}
