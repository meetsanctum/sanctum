import { ContactClosed, ContactOpen, type Tile } from "@meetsanctum/ui-sdk";

import { contactsOf, contactsSentence } from "./contact";

// What opens Security's page: whether the home's contact sensors are all
// closed, and which are open, in a row above their tiles. Its round is
// White while any is open. The row only tells: each sensor's tile below
// opens its detail.
export function SecurityOverview(props: { tiles: readonly Tile[] }) {
  const contacts = contactsOf(props.tiles);
  if (!contacts) return null;
  const open = contacts.open.length > 0;
  const Icon = open ? ContactOpen : ContactClosed;
  return (
    <p className="m-0 flex shrink-0 items-center gap-3 rounded-lg bg-(--tile) px-3.5 py-3 text-(--tile-ink) backdrop-blur-[24px]">
      <span
        aria-hidden="true"
        data-active={open ? "" : undefined}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-(--tile-chip) data-active:bg-(--tile-on) data-active:text-(--tile-on-ink)"
      >
        <Icon className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-sm font-medium">Contact sensors</span>
        <span className="truncate text-[13px] font-medium text-(--tile-secondary)">
          {contactsSentence(contacts)}
        </span>
      </span>
    </p>
  );
}
