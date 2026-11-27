import type { InviteInfo, PersonInfo } from "@meetsanctum/auth-protocol";
import { Button, useHomeClock } from "@meetsanctum/ui-sdk";
import { Check } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { Row, Section } from "../components";
import type { SignIn } from "./data";
import { untilText } from "./words";

// A person's Sign-In card: one thing per row, what it is on the left and
// its value or its actions on the right, as each device's row is. Someone
// who signs in has a Username row and a Password row; on your own page
// Password offers Change password, on anyone else's Reset password. A code
// waiting for a new password is a row of its own. Someone who doesn't sign
// in, or whose invite is waiting or ended, has one row about it. Removing a
// sign-in is at the page's foot, with removing the person.

function CardRow(props: {
  title: string;
  detail?: ReactNode;
  wrapDetail?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
      <Row
        title={props.title}
        detail={props.detail}
        wrapDetail={props.wrapDetail}
      />
      {props.children && (
        <div className="ms-auto flex max-w-full flex-wrap justify-end gap-2">
          {props.children}
        </div>
      )}
    </div>
  );
}

export function SignInCard(props: {
  person: PersonInfo;
  signIn: SignIn;
  // Your own page, on a device signed in as you.
  own: boolean;
  // You changed your password from this page just now.
  changed: boolean;
  stale: boolean;
  changeTrigger?: Ref<HTMLButtonElement>;
  onChangePassword: () => void;
  onInvite: (kind: "invite" | "reset") => void;
  onCancelCode: (code: InviteInfo, trigger: HTMLButtonElement) => void;
}) {
  const clock = useHomeClock();
  const { signIn, person } = props;
  const small = (
    label: string,
    onClick: (trigger: HTMLButtonElement) => void,
    ref?: Ref<HTMLButtonElement>,
  ) => (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      disabled={props.stale}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {label}
    </Button>
  );

  let rows: ReactNode;
  switch (signIn.state) {
    case "signs-in": {
      const reset = signIn.reset;
      rows = (
        <>
          <CardRow title="Username">
            <span className="text-sm text-muted-foreground">
              {signIn.username}
            </span>
          </CardRow>
          <CardRow
            title="Password"
            detail={
              props.own && props.changed ? (
                <span role="status" className="flex items-center gap-1.5">
                  <Check aria-hidden="true" className="size-3.5 shrink-0" />
                  Changed just now
                </span>
              ) : undefined
            }
          >
            {props.own
              ? small(
                  "Change password",
                  () => props.onChangePassword(),
                  props.changeTrigger,
                )
              : !reset &&
                small("Reset password", () => props.onInvite("reset"))}
          </CardRow>
          {reset && (
            <CardRow
              title="Password code"
              detail={`Works until ${untilText(clock, reset.endsAt)}`}
              wrapDetail
            >
              {small("Cancel code", (trigger) =>
                props.onCancelCode(reset, trigger),
              )}
            </CardRow>
          )}
        </>
      );
      break;
    }
    case "invited":
      rows = (
        <CardRow
          title="Invite"
          detail={`Works until ${untilText(clock, signIn.invite.endsAt)}`}
          wrapDetail
        >
          {small("New invite code", () => props.onInvite("invite"))}
          {small("Cancel invite", (trigger) =>
            props.onCancelCode(signIn.invite, trigger),
          )}
        </CardRow>
      );
      break;
    case "invite-ended":
      rows = (
        <CardRow
          title="Invite"
          detail={
            signIn.ended === "cancelled"
              ? "The code was cancelled."
              : "The code ran out."
          }
        >
          {small("New invite code", () => props.onInvite("invite"))}
        </CardRow>
      );
      break;
    case "none":
      rows = (
        <CardRow title="Doesn't sign in">
          <Button
            size="sm"
            disabled={props.stale}
            onClick={() => props.onInvite("invite")}
          >
            Invite to sign in
          </Button>
        </CardRow>
      );
      break;
  }
  return (
    <Section id={`${person.id}-sign-in`} title="Sign-In">
      <div className="flex flex-col gap-3">{rows}</div>
    </Section>
  );
}
