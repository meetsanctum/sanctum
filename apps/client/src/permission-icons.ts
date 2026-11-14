import type { PermissionIcon } from "@meetsanctum/app-sdk";
import {
  Activity,
  CircleDot,
  DoorClosed,
  Globe,
  Lightbulb,
  MapPin,
  Radar,
  RadioTower,
  Share2,
  Shield,
  SquarePlus,
  Thermometer,
  ToggleRight,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/** The Lucide icon for each of the icons a permission may have (app-sdk's permissionIcons). */
export const permissionIconOf: Record<PermissionIcon, LucideIcon> = {
  "door-closed": DoorClosed,
  "map-pin": MapPin,
  users: Users,
  lightbulb: Lightbulb,
  "toggle-right": ToggleRight,
  "circle-dot": CircleDot,
  thermometer: Thermometer,
  activity: Activity,
  "square-plus": SquarePlus,
  workflow: Workflow,
  globe: Globe,
  "radio-tower": RadioTower,
  radar: Radar,
  "share-2": Share2,
  shield: Shield,
};
