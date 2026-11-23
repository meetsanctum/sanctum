import { z } from "zod";

// What a remote's presses are called: an action's name as its driver says it,
// and the button and the press that name tells.

/**
 * One of a button's press actions, by its driver's name, such as single,
 * double, hold or Zigbee2MQTT's on_press and up_hold.
 */
export const buttonAction = z
  .string()
  .regex(
    /^[A-Za-z0-9][\w.:-]{0,63}$/,
    "use a short action name such as single",
  );

// The words for a kind of press at the end of an action's name.
const pressWords = new Set([
  "press",
  "hold",
  "click",
  "single",
  "double",
  "triple",
  "quadruple",
  "many",
  "long",
]);

/**
 * One of a remote's actions as its button and the press, as drivers name
 * them: up_hold is the up button's hold and button_1_double button 1's
 * double press; single, with no button named, is the remote's one button.
 * A press word before press is one press, as ESPHome's firmware names them:
 * double_press is a double press, up_long_press the up button's long press.
 */
export function pressParts(action: string): {
  button: string | null;
  press: string;
} {
  const words = action.split("_");
  const last = words.at(-1)!.toLowerCase();
  const before = words.at(-2)?.toLowerCase();
  const length =
    last === "press" &&
    before !== undefined &&
    before !== "press" &&
    pressWords.has(before)
      ? 2
      : 1;
  if (words.length <= length || !pressWords.has(last)) {
    return { button: null, press: action };
  }
  return {
    button: words.slice(0, -length).join("_"),
    press: words.slice(-length).join("_"),
  };
}
