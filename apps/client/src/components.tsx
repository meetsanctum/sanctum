import { cn } from "cn";
import type { CSSProperties, InputHTMLAttributes, ReactNode } from "react";

import { backdropOn } from "./backdrop";
import { productName } from "./brand";
import { knotPath } from "./knot";
import { AvatarFallback, Avatar as AvatarRoot } from "./components/ui/avatar";
import { getShell } from "./shell";
import { Button, PageBar, usePhone } from "@meetsanctum/ui-sdk";
import { ChevronLeft } from "lucide-react";

// Small pieces the screens share.

// In the desktop app on macOS the window has no title bar: this strip along
// the top of a screen moves the window instead. Nothing under it can be
// clicked, so screens keep their top 40 px clear.
export function WindowDragArea() {
  if (getShell().platform !== "macos") {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-30 h-10 [-webkit-app-region:drag]"
    />
  );
}

// A person by their identity colour and initials.
export function Avatar(props: {
  name: string;
  colour: string;
  size?: "default" | "lg";
}) {
  const initials = props.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <AvatarRoot size={props.size} aria-hidden="true">
      <AvatarFallback
        className="font-medium text-(--carbon)"
        style={{ background: props.colour }}
      >
        {initials}
      </AvatarFallback>
    </AvatarRoot>
  );
}

export function Field(
  props: {
    label: string;
    hint?: string;
  } & InputHTMLAttributes<HTMLInputElement>,
) {
  const { label, hint, ...input } = props;
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input {...input} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// The horizontal lockup (assets/brand/README.md): the knot beside the name,
// which the logo sets in lower case, in the colour of the text around it.
// The knot is 28 px, two pixels to a unit, so it stays crisp on a 1× screen.
export function Logo(props: { className?: string }) {
  return (
    <div className={cn("logo", props.className)}>
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path fill="currentColor" d={knotPath} />
      </svg>
      <span>{productName}</span>
    </div>
  );
}

const backdrop = backdropOn(new Date());

// A centred card for the screens before the dashboard, under the logo. Where
// there is room, its title and what it explains (`intro`) sit beside what it
// asks for (`children`); elsewhere they stack.
export function Sheet(props: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
}) {
  return (
    <main
      data-mode="evening"
      className="sheet-screen"
      style={
        {
          "--backdrop": `url("${backdrop.url}")`,
          "--backdrop-colour": backdrop.colour,
        } as CSSProperties
      }
    >
      <WindowDragArea />
      <Logo className="sheet-logo" />
      <section className="card sheet" aria-labelledby="sheet-title">
        <div className="sheet-column">
          {props.onBack && (
            <Button
              variant="link"
              size="inline"
              type="button"
              className="back self-start"
              onClick={props.onBack}
            >
              Back
            </Button>
          )}
          <h1 id="sheet-title" className="sheet-title">
            {props.title}
          </h1>
          {props.intro}
        </div>
        <div className="sheet-column">{props.children}</div>
      </section>
    </main>
  );
}

// A titled part of an app's page, such as one of Settings: its heading, with
// a hint and an action beside it, over a filled card. A part that is the
// whole of its page, such as Settings' Devices, gives its title and action
// to the page's bar instead, after the way back, so the title isn't said
// twice; its hint leads the card.
export function Section(props: {
  id: string;
  title: string;
  // Its heading's level, such as 3 inside a dialog with its own title.
  level?: 2 | 3;
  hint?: string;
  // The hint says a problem, in red.
  problem?: boolean;
  action?: ReactNode;
  // The way back of the page it is the whole of, which makes it that page.
  page?: ReactNode;
  children: ReactNode;
}) {
  const Heading = props.level === 3 ? "h3" : "h2";
  const hint = props.hint && (
    <span
      className={cn(
        "truncate text-[13px] font-medium text-muted-foreground",
        props.problem && "text-destructive",
      )}
    >
      {props.hint}
    </span>
  );
  const card = (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-card px-4 py-3.5 text-card-foreground">
      {props.children}
    </div>
  );
  if (props.page !== undefined) {
    return (
      <>
        <PageBar title={props.title} leading={props.page}>
          {props.action}
        </PageBar>
        <section
          id={props.id}
          aria-label={props.title}
          className="flex min-w-0 shrink-0 flex-col gap-2"
        >
          {hint}
          {card}
        </section>
      </>
    );
  }
  return (
    <section
      aria-labelledby={props.id}
      className="flex min-w-0 shrink-0 flex-col gap-2"
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <Heading
            id={props.id}
            className="m-0 text-[15px] leading-5 font-medium"
          >
            {props.title}
          </Heading>
          {hint}
        </div>
        {props.action}
      </div>
      {card}
    </section>
  );
}

/**
 * A page's way back to the one it was opened from, before its title, named
 * for that page: on a phone its chevron alone, as the bar's other buttons
 * are there.
 */
export function BackButton(props: { to: string; onBack: () => void }) {
  const isPhone = usePhone();
  return (
    <Button
      variant={isPhone ? "ghost" : "outline"}
      size={isPhone ? "bar" : "default"}
      aria-label={`Back to ${props.to}`}
      onClick={props.onBack}
      className="me-2"
    >
      <ChevronLeft data-icon="inline-start" aria-hidden="true" />
      {!isPhone && props.to}
    </Button>
  );
}

export function SettingsPageBar(props: {
  title: string;
  backTo?: string;
  onBack: () => void;
}) {
  return (
    <PageBar
      title={props.title}
      leading={
        props.backTo && <BackButton to={props.backTo} onBack={props.onBack} />
      }
    >
      {!props.backTo && (
        <Button variant="outline" onClick={props.onBack}>
          Done
        </Button>
      )}
    </PageBar>
  );
}

// A thing and a line about it.
export function Row(props: { title: string; detail: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-px leading-tight">
      <span className="truncate text-sm font-medium">{props.title}</span>
      <span className="truncate text-[13px] font-medium text-muted-foreground">
        {props.detail}
      </span>
    </span>
  );
}
