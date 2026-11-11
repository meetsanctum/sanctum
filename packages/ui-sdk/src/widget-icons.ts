import type { WidgetIcon } from "@meetsanctum/app-sdk";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  type LucideIcon,
} from "lucide-react";

import { tileIconOf } from "./tile-icons";

/** The Lucide icon for each of the icons a widget may show (app-sdk's widgetIcons). */
export const widgetIconOf: Record<WidgetIcon, LucideIcon> = {
  ...tileIconOf,
  cloud: Cloud,
  "cloud-sun": CloudSun,
  "cloud-fog": CloudFog,
  "cloud-drizzle": CloudDrizzle,
  "cloud-rain": CloudRain,
  "cloud-snow": CloudSnow,
  "cloud-lightning": CloudLightning,
  "cloud-hail": CloudHail,
};
