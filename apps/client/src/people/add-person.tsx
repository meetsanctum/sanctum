import type {
  AddPerson as AddPersonInput,
  PersonInfo,
} from "@meetsanctum/auth-protocol";
import { Button, Input } from "@meetsanctum/ui-sdk";
import { useId, useState, type FormEvent } from "react";

import { ColourPicker, leastUsedColour } from "../colour-picker";
import { Avatar } from "../components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { coreJson } from "../core-fetch";

// Adding a person to the household: their name and colour, the avatar
// showing them as they are typed. Whether they sign in is their page's to
// say: a child or a guest is a person who doesn't.

export function AddPerson(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The household's colours, so a new person starts with one few have.
  taken: readonly string[];
  onAdded: (person: PersonInfo) => void;
}) {
  const ids = useId();
  const [name, setName] = useState("");
  const [colour, setColour] = useState(() => leastUsedColour(props.taken));
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const { open, taken } = props;

  // Each time it opens, it starts afresh.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setColour(leastUsedColour(taken));
      setProblem(undefined);
      setWorking(false);
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || working) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const added = await coreJson<PersonInfo>("/api/people/add", {
        method: "POST",
        json: { name: trimmed, colour } satisfies AddPersonInput,
      });
      props.onOpenChange(false);
      props.onAdded(added);
    } catch {
      setProblem("That didn't work. Try again.");
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!working) props.onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Add a person</DialogTitle>
            <DialogDescription>
              Someone who lives here. Their name and colour show who did what at
              home.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-end gap-4">
            <span className="mb-0.5">
              <Avatar name={name} colour={colour} size="lg" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label
                htmlFor={`${ids}-name`}
                className="text-[13px] leading-[18px] font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={60}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
              />
            </div>
          </div>
          <ColourPicker
            legend="Colour"
            name={`${ids}-colour`}
            value={colour}
            onChange={setColour}
            surface="var(--color-popover)"
          />
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={working}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={working || !name.trim()}>
              {working ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
