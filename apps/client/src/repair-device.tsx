import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { deviceProblem } from "./device-parts";
import { QuestionField, type Refused } from "./device-questions";

// Repair: what a device's driver asks to set it right, in the words it
// declares. The answers go to the core once, in the body of one request, and
// stay nowhere: the fields empty as the dialog closes, however it closes. A
// refused answer says why under its field, which keeps what was typed so it
// can be corrected.

type RepairResult = { repaired: DeviceInfo } | { refused: Refused };

function repairProblem(error: unknown, appName: string | null) {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "unavailable":
        return `${appName ?? "Its app"} isn't running, so it can't repair it now.`;
      case "timeout":
        return "It didn't answer in time. Check it's switched on, then try again.";
      case "conflict":
        return "It doesn't need repairing any more.";
      case "app_failed":
        return `${appName ?? "Its app"} couldn't repair it. Try again.`;
    }
  }
  return deviceProblem(error);
}

export function RepairDevice(props: {
  // The device being repaired, while the dialog is open.
  device?: DeviceInfo;
  appName: string | null;
  onClose: () => void;
  onRepaired: (device: DeviceInfo) => void;
}) {
  const ids = useId();
  // What the dialog showed stays while it closes.
  const last = useRef<DeviceInfo>(undefined);
  if (props.device) last.current = props.device;
  const device = last.current;
  const repair = device?.problem?.repair ?? null;
  const asks = repair?.asks ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Refused>();
  const [failure, setFailure] = useState<string>();
  const [working, setWorking] = useState(false);
  const current = useRef(props.device);
  current.current = props.device;
  const request = useRef(0);

  // Opening and closing both start afresh, so no answer outlives the dialog.
  useEffect(() => {
    request.current += 1;
    setAnswers({});
    setRefused(undefined);
    setFailure(undefined);
    setWorking(false);
    return () => {
      request.current += 1;
    };
  }, [props.device?.id, !!props.device]);

  const answerTo = (id: string) =>
    Object.hasOwn(answers, id) ? answers[id]! : "";
  const complete = asks.every((question) => answerTo(question.id) !== "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const repairing = props.device;
    if (!repairing || !complete || working) return;
    const pending = ++request.current;
    setWorking(true);
    setRefused(undefined);
    setFailure(undefined);
    try {
      const result = await coreJson<RepairResult>("/api/devices/repair", {
        method: "POST",
        json: { id: repairing.id, answers },
      });
      if (current.current !== repairing || request.current !== pending) return;
      setWorking(false);
      if ("refused" in result) {
        setRefused(result.refused);
        return;
      }
      props.onRepaired(result.repaired);
      props.onClose();
    } catch (error) {
      if (current.current !== repairing || request.current !== pending) return;
      setWorking(false);
      setFailure(repairProblem(error, props.appName));
    }
  };

  return (
    <Dialog
      open={!!props.device}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Repair {device?.name}</DialogTitle>
            <DialogDescription>
              {repair?.help ?? device?.problem?.words}
            </DialogDescription>
          </DialogHeader>
          {asks.map((question, index) => (
            <QuestionField
              key={question.id}
              id={`${ids}-${question.id}`}
              question={question}
              value={answerTo(question.id)}
              refused={refused}
              autoFocus={index === 0}
              onChange={(value) =>
                setAnswers((before) => ({ ...before, [question.id]: value }))
              }
            />
          ))}
          {failure && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={working || !complete}>
              {working ? "Repairing…" : "Repair"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
