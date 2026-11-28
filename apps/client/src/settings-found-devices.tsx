import type { FoundDevice } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";

import { Section } from "./components";
import { DeviceIcon } from "./device-parts";

// A category's page in Settings → Devices, under its devices: those found
// on the home's network that its app says are of this kind, each with Add,
// which opens the dialog that adds it. They're drawn quieter than the
// devices the home has, its icon at half strength and its words in the
// lesser greys, while Add stays as every other button, so they read as
// waiting rather than as unavailable.

/** What marks a found device's Add, so focus can come back to it. */
export const foundAddKey = (found: Pick<FoundDevice, "driver" | "key">) =>
  `${found.driver}/${found.key}`;

/**
 * Puts focus where it belongs once adding closes: on the Add it came from
 * if that device is still to add, else on the next one, else on fallback.
 */
export function focusAfterAdding(
  found: Pick<FoundDevice, "driver" | "key"> | undefined,
  fallback: HTMLElement | null,
) {
  const all = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-found-add]"),
  ];
  const own = found
    ? all.find((each) => each.dataset.foundAdd === foundAddKey(found))
    : undefined;
  (own ?? all[0] ?? fallback)?.focus();
}

export function FoundDevicesSection(props: {
  found: readonly FoundDevice[];
  appName: (driver: string) => string | null;
  onAdd: (found: FoundDevice) => void;
}) {
  if (props.found.length === 0) return null;
  return (
    <Section id="settings-found-devices" title="Found on Your Network">
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {props.found.map((found) => {
          // What it is first, so a narrow screen cuts the app, not the model.
          const line = [found.description, props.appName(found.driver)]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              key={`${found.driver}\u0000${found.key}`}
              className="flex items-center gap-3"
            >
              <span className="opacity-50">
                <DeviceIcon type={found.type} />
              </span>
              <span className="flex min-w-0 flex-col gap-px leading-tight">
                <span className="truncate text-sm font-medium text-muted-foreground">
                  {found.name}
                </span>
                {line && (
                  <span className="truncate text-[13px] font-medium text-gray">
                    {line}
                  </span>
                )}
              </span>
              <Button
                variant="outline"
                className="ms-auto shrink-0"
                // Where focus goes once a dialog it opened closes.
                data-found-add={foundAddKey(found)}
                // What it is too, so a device named after a room isn't
                // heard as one.
                aria-label={
                  found.description
                    ? `Add ${found.name}, ${found.description}`
                    : `Add ${found.name}`
                }
                onClick={() => props.onAdd(found)}
              >
                Add
              </Button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
