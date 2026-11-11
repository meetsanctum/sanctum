import type { WidgetIcon } from "@meetsanctum/app-sdk";

// What a WMO weather code (Open-Meteo's weather_code) means, in words and as
// one of the icons a widget may show; a clear night shows the moon.

type Condition = { text: string; icon: WidgetIcon };

const unknown: Condition = { text: "Unknown", icon: "cloud" };

export function condition(code: number | null, isDay = true): Condition {
  if (code === null) return unknown;
  if (code === 0) {
    return { text: "Clear", icon: isDay ? "sun" : "moon" };
  }
  if (code === 1 || code === 2) {
    return {
      text: code === 1 ? "Mostly clear" : "Partly cloudy",
      icon: isDay ? "cloud-sun" : "cloud-moon",
    };
  }
  if (code === 3) return { text: "Overcast", icon: "cloud" };
  if (code === 45 || code === 48) return { text: "Fog", icon: "cloud-fog" };
  if (code >= 51 && code <= 55) {
    return { text: "Drizzle", icon: "cloud-drizzle" };
  }
  if (code === 56 || code === 57) {
    return { text: "Freezing drizzle", icon: "cloud-drizzle" };
  }
  if (code === 61) return { text: "Light rain", icon: "cloud-rain" };
  if (code === 63) return { text: "Rain", icon: "cloud-rain" };
  if (code === 65) return { text: "Heavy rain", icon: "cloud-rain" };
  if (code === 66 || code === 67) {
    return { text: "Freezing rain", icon: "cloud-rain" };
  }
  if (code === 71) return { text: "Light snow", icon: "cloud-snow" };
  if (code === 73) return { text: "Snow", icon: "cloud-snow" };
  if (code === 75) return { text: "Heavy snow", icon: "cloud-snow" };
  if (code === 77) return { text: "Snow grains", icon: "cloud-snow" };
  if (code >= 80 && code <= 82) {
    return { text: "Showers", icon: "cloud-rain" };
  }
  if (code === 85 || code === 86) {
    return { text: "Snow showers", icon: "cloud-snow" };
  }
  if (code === 95) return { text: "Thunderstorm", icon: "cloud-lightning" };
  if (code === 96 || code === 99) {
    return { text: "Thunderstorm with hail", icon: "cloud-hail" };
  }
  return unknown;
}
