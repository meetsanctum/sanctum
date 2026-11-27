import { Button, Input } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { ChevronRight, CircleAlert, type LucideIcon } from "lucide-react";
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { BackButton, Logo, WindowDragArea } from "../components";
import { Skeleton } from "../components/ui/skeleton";
import { KnotLoader } from "../knot-loader";

// The screens before the dashboard share one sheet: a single column of
// frosted Carbon glass over the Graphite backdrop, under the logo. Its head
// is centred: a symbol on screens that start something, the title naming
// the screen and one line on what it is for. What it asks for follows,
// then its one primary action. Back, where there is a way back, is named
// for where it goes.

export function Sheet(props: {
  title: string;
  subtitle?: ReactNode;
  glyph?: LucideIcon;
  // A warning's symbol is in Sun, so a changed certificate reads apart from
  // a screen that only asks something.
  warning?: boolean;
  // Where Back goes, named for it where its title is short enough.
  back?: { to?: string; onBack: () => void; disabled?: boolean };
  // The pairing code and its steps need the width of a wall display.
  wide?: boolean;
  children: ReactNode;
}) {
  const Glyph = props.glyph;
  return (
    <main data-mode="evening" className="sheet-screen">
      <WindowDragArea />
      <Logo className="sheet-logo" />
      <section
        aria-labelledby="sheet-title"
        className={cn(
          "flex w-full min-w-0 flex-col gap-6 self-center rounded-xl bg-(--glass) px-8 pt-7 pb-8 text-foreground shadow-[inset_0_0_0_1px_var(--glass-line)] max-sm:px-5",
          props.wide ? "max-w-190" : "max-w-110",
        )}
      >
        {props.back && (
          <div className="-mb-3 flex">
            <BackButton {...props.back} />
          </div>
        )}
        <header className="flex flex-col items-center gap-2 text-center">
          {Glyph && (
            <span
              className={cn(
                "mb-1.5 flex size-13 items-center justify-center rounded-lg bg-foreground/11",
                props.warning && "text-(--sun-on-carbon)",
              )}
            >
              <Glyph aria-hidden="true" className="size-7" strokeWidth={1.75} />
            </span>
          )}
          <h1
            id="sheet-title"
            className="m-0 text-2xl leading-[30px] font-semibold tracking-[-0.01em] text-balance"
          >
            {props.title}
          </h1>
          {props.subtitle && (
            <p className="m-0 max-w-90 text-[15px] leading-[21px] text-balance text-muted-foreground">
              {props.subtitle}
            </p>
          )}
        </header>
        {props.children}
      </section>
    </main>
  );
}

// A labelled field with its rule underneath and a link to its problem.
// The sheet uses a 44 px input so a finger finds it on a wall display.
export function SheetField(
  props: {
    label: string;
    hint?: string;
    // The id of the problem about this field.
    problemId?: string;
    compact?: boolean;
    ref?: Ref<HTMLInputElement>;
    children?: ReactNode;
  } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "id" | "aria-invalid" | "aria-describedby"
  >,
) {
  const { label, hint, problemId, compact, children, ...input } = props;
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn("flex flex-col", compact ? "gap-2" : "gap-1.5")}>
      <label
        htmlFor={id}
        className="text-[13px] leading-[18px] font-medium text-muted-foreground"
      >
        {label}
      </label>
      <Input
        className={
          compact
            ? undefined
            : "h-11 rounded-md px-3.5 text-[15px] md:text-[15px]"
        }
        {...input}
        id={id}
        aria-invalid={problemId ? true : undefined}
        aria-describedby={
          [hint && hintId, problemId].filter(Boolean).join(" ") || undefined
        }
      />
      {hint && (
        <span
          id={hintId}
          className="text-[13px] leading-[18px] text-muted-foreground"
        >
          {hint}
        </span>
      )}
      {children}
    </div>
  );
}

// What went wrong, beside what it is about: a symbol and the words, never
// the colour alone.
export function SheetProblem(props: { id?: string; children: ReactNode }) {
  return (
    <p
      id={props.id}
      role="alert"
      className="m-0 flex items-start gap-2 text-sm leading-5 text-destructive"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{props.children}</span>
    </p>
  );
}

// A quiet line with its symbol, such as how a sign-in is stored.
export function SheetNote(props: { icon: LucideIcon; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <p className="m-0 flex items-start gap-2 text-[13px] leading-[18px] text-muted-foreground">
      <Icon aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>{props.children}</span>
    </p>
  );
}

// What the sheet is waiting for, in words, with the knot turning beside
// them.
export function SheetStatus(props: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="m-0 flex items-center justify-center gap-2.5 text-[15px] leading-[21px] text-muted-foreground"
    >
      <KnotLoader className="size-7 shrink-0" />
      {props.children}
    </p>
  );
}

// A row that leads to the next screen: its symbol in a tile, its name, a
// line under it where there is one, and a chevron.
export function SheetRow(props: {
  icon: LucideIcon;
  name: string;
  detail?: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Button
      variant="tile"
      size="sheet-row"
      type="button"
      onClick={props.onClick}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-foreground/8">
        <Icon aria-hidden="true" className="size-5.5" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] leading-5 font-medium">{props.name}</span>
        {props.detail && (
          <span className="text-[13px] leading-[18px] text-muted-foreground">
            {props.detail}
          </span>
        )}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
    </Button>
  );
}

// The rows' shapes while the list is on its way.
export function SheetRowsLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <Skeleton className="h-16 rounded-md" />
      <Skeleton className="h-16 rounded-md opacity-55" />
    </div>
  );
}

// The sheet's actions, its one primary action first, then the quieter ways
// on, centred under it.
export function SheetActions(props: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">{props.children}</div>
  );
}

// What the primary button says while its action runs: the knot, then the
// step.
export function Busy(props: { children: ReactNode }) {
  return (
    <>
      <KnotLoader className="size-3.5" />
      {props.children}
    </>
  );
}
