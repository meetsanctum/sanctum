import type { PasswordProblem } from "@meetsanctum/auth-protocol";

import { productName } from "../brand";
import { CoreError } from "../core-fetch";
import { SignInError } from "./device";

// What to tell a person when claiming or signing in did not work.
export function problemText(error: unknown): string {
  if (error instanceof SignInError) {
    switch (error.code) {
      case "wrong_username_or_password":
        return "Wrong username or password.";
      case "unconfirmed":
        return "This home could not prove it is yours. Nothing was saved.";
      case "another_host":
        return "A different home answers where this one was found. Choose your home again.";
      case "unchecked":
        return "This app can't check this home's security certificate.";
    }
  }
  if (error instanceof CoreError) {
    switch (error.code) {
      case "sign_in_failed":
      case "expired":
        return "That took too long. Try again.";
      case "channel_mismatch":
        return `Something on this network may be listening in, so ${productName} refused. Check that you are on your home Wi-Fi.`;
      case "too_many_attempts":
        return "Too many attempts from this device. Try again in 15 minutes.";
      case "busy":
      case "host_starting":
        return `${productName} is busy. Try again in a moment.`;
      case "claimed":
        return "This home has just been set up. Sign in instead.";
      case "invalid_request":
        return "Check the details and try again.";
    }
    return `${productName} ran into a problem. Try again.`;
  }
  return `Can't reach ${productName}. Check that this device is on your home Wi-Fi.`;
}

export function passwordProblemText(problem: PasswordProblem) {
  return problem === "too_short"
    ? "Use at least 8 characters."
    : "That password is too long.";
}
