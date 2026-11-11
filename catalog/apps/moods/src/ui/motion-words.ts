import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { formatLightLevel } from "@meetsanctum/ui-sdk";

import {
  lightLevelIn,
  lightSensorsIn,
  motionSensorsIn,
  type RoomMotion,
} from "../motion/room-motion.js";
import { namesWords } from "./schedule-words";

// The words of the Motion section on Moods' page for a room and of a room's
// line on Moods' main page, apart from the pages so they can be checked on
// their own.

/** Such as "10 minutes" or "1 hour". */
export function minutesWords(minutes: number) {
  return minutes === 60 ? "1 hour" : `${minutes} minutes`;
}

/** What motion does to a room, as its line on Moods' main page says it; null for nothing. */
export function motionLine(motion: RoomMotion | undefined) {
  const on = motion?.turnOn === true;
  const off = motion?.turnOffAfter != null;
  if (on && off) return "On and off with motion";
  if (on) return "On with motion";
  if (off) return "Off with no motion";
  return null;
}

const counted = (count: number) =>
  count === 2 ? "two sensors" : `${count} sensors`;

/** What the Motion section says about a room, from its sensors as they are. */
export function motionWords(options: {
  room: { id: string; name: string };
  devices: readonly DeviceInfo[];
  motion: RoomMotion;
}) {
  const { room, devices, motion } = options;
  const sensors = motionSensorsIn(devices, room.id);
  const names = (each: readonly DeviceInfo[]) =>
    namesWords(each.map((device) => device.name));
  const offline = sensors.filter((device) => device.availability === "offline");
  const answering = sensors.filter(
    (device) => device.availability !== "offline",
  );
  const lightSensors = lightSensorsIn(devices, room.id);
  const level = lightLevelIn(devices, room.id);

  const sensorless = sensors.length === 0;
  const readsLight = lightSensors.length > 0;
  const noSensor = `${room.name} has no motion sensor`;

  let levelLine: string;
  if (!readsLight) {
    levelLine =
      sensors.length > 1
        ? "Its motion sensors don't read the light level"
        : "Its motion sensor doesn't read the light level";
  } else if (level !== null) {
    levelLine = `${room.name} reads ${formatLightLevel(level)} now`;
  } else if (
    lightSensors.every((device) => device.availability === "offline")
  ) {
    levelLine =
      lightSensors.length > 1
        ? "No reading while they're offline"
        : "No reading while it's offline";
  } else {
    levelLine = "Waiting for a reading";
  }

  let foot: { text: string; bad: boolean };
  if (sensorless) {
    foot = {
      text: `To use these, add a motion sensor to ${room.name} in Settings.`,
      bad: false,
    };
  } else if (offline.length > 0) {
    const one = offline.length === 1;
    const [is, back] = one ? ["is", "it's"] : ["are", "they're"];
    if (answering.length > 0) {
      const sees = answering.length === 1 ? "sees" : "see";
      foot = {
        text: `${names(offline)} ${is} offline, so only ${names(answering)} ${sees} motion until ${back} back.`,
        bad: true,
      };
    } else {
      const off = motion.turnOffAfter !== null;
      const to =
        motion.turnOn && !off
          ? "on"
          : off && !motion.turnOn
            ? "off"
            : "on or off";
      foot = {
        text: `${names(offline)} ${is} offline, so motion can't turn the lights ${to} until ${back} back.`,
        bad: true,
      };
    }
  } else if (sensors.length > 1) {
    const [any, all] =
      sensors.length === 2 ? ["either", "both"] : ["any", "all"];
    foot = {
      text: `With ${counted(sensors.length)}, there's motion if ${any} sees it, and no motion once ${all} have been quiet that long.`,
      bad: false,
    };
  } else {
    foot = {
      text: `With motion, the lights come on as turning ${room.name} on brings. These run as two of the home's automations, changed only here.`,
      bad: false,
    };
  }

  return {
    /** The room's motion sensors, beside the heading; none without one. */
    hint: sensorless ? undefined : names(sensors),
    sensorless,
    readsLight,
    turnOnLine: sensorless
      ? noSensor
      : `When every light in ${room.name} is off`,
    turnOffLine: sensorless
      ? noSensor
      : `Every light in ${room.name}, however it came on`,
    levelLine,
    foot,
  };
}
