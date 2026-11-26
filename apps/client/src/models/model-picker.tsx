import type { ModelChoice } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { sizeText } from "./words";

// A model to choose from a source's list, which can run to hundreds at a
// provider: a field that opens a search over them. A provider's names, such
// as "Anthropic: Claude Sonnet 5.5", are grouped by their maker, each row
// keeping the model's own name; a computer's few carry their size. It
// filters by what's typed itself, a plain match in a name, so a keystroke
// costs little with hundreds listed.

type Entry = { choice: ModelChoice; maker?: string; name: string };

const makerOf = /^([^:]{1,40}):\s+(.+)$/;

function entriesOf(models: readonly ModelChoice[]): Entry[] {
  return models.map((choice) => {
    const named = makerOf.exec(choice.name);
    return named
      ? { choice, maker: named[1]!.trim(), name: named[2]!.trim() }
      : { choice, name: choice.name };
  });
}

function shownName(entry: Entry) {
  const name = entry.maker ? `${entry.name} · ${entry.maker}` : entry.name;
  return entry.choice.size ? `${name} · ${sizeText(entry.choice.size)}` : name;
}

// The part of a name that matches what's typed, in bold.
function marked(text: string, query: string): ReactNode {
  if (!query) return text;
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-semibold">
        {text.slice(at, at + query.length)}
      </strong>
      {text.slice(at + query.length)}
    </>
  );
}

const count = (models: number) =>
  models === 1 ? "1 model" : `${models} models`;

export function ModelPicker(props: {
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  models: readonly ModelChoice[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const entries = useMemo(() => entriesOf(props.models), [props.models]);
  const chosen = entries.find((entry) => entry.choice.id === props.value);
  const typed = query.trim().toLowerCase();
  const matches = typed
    ? entries.filter(
        (entry) =>
          entry.choice.name.toLowerCase().includes(typed) ||
          entry.choice.id.toLowerCase().includes(typed),
      )
    : entries;
  const hasMakers = entries.some((entry) => entry.maker);
  // In the list's order, each maker once, where its first model is.
  const groups = new Map<string, Entry[]>();
  for (const entry of matches) {
    const key = entry.maker ?? "";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      // Over a dialog, the list scrolls only as a modal popover.
      modal
    >
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          type="button"
          variant="outline"
          size="field"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={props["aria-label"]}
          aria-describedby={props["aria-describedby"]}
          disabled={props.disabled}
        >
          <span
            className={
              chosen ? "min-w-0 truncate" : "truncate text-muted-foreground"
            }
          >
            {chosen ? shownName(chosen) : "Choose a model"}
          </span>
          <ChevronsUpDown aria-hidden="true" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) gap-0 overflow-hidden p-0"
      >
        <Command shouldFilter={false} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${count(entries.length)}`}
            aria-label="Search models"
          />
          <CommandList id={listId}>
            <CommandEmpty className="px-3 text-[13px] leading-[18px] font-medium text-muted-foreground">
              No models match “{query.trim()}”.
              <br />
              {hasMakers
                ? "Check the spelling, or search for the maker."
                : "Check the spelling."}
            </CommandEmpty>
            {[...groups].map(([maker, models]) => (
              <CommandGroup key={maker || "-"} heading={maker || undefined}>
                {models.map((entry) => (
                  <CommandItem
                    key={entry.choice.id}
                    value={entry.choice.id}
                    onSelect={() => {
                      props.onChange(entry.choice.id);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {marked(entry.name, typed)}
                    </span>
                    {entry.choice.size !== undefined && (
                      <span className="text-xs font-medium text-muted-foreground">
                        {sizeText(entry.choice.size)}
                      </span>
                    )}
                    <Check
                      aria-hidden="true"
                      className={
                        entry.choice.id === props.value
                          ? "opacity-100"
                          : "opacity-0"
                      }
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {typed && matches.length > 0 && (
            <p className="m-0 px-3 pt-1 pb-2 text-xs font-medium text-muted-foreground">
              {matches.length} of {count(entries.length)}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
