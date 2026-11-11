import type {
  AppInfo,
  DeviceInfo,
  EntityInfo,
  PieceInfo,
  Places,
  WorkflowGraph,
  WorkflowInfo,
  WorkflowRunInfo,
} from "@meetsanctum/app-sdk";
import type { PersonInfo } from "@meetsanctum/auth-protocol";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { productName } from "../brand";
import { CoreError, coreJson } from "../core-fetch";
import type { Names } from "./words";

// What Automations reads from the core: the household's workflows and the
// pieces they are built from, which every person and shared device may read
// and change, and the entities their configs name. Workflows have no live
// messages, so the list reloads whenever the live feed refreshes and after
// each change made here.

export type NewWorkflow = {
  name: string;
  enabled?: boolean;
  runMode?: WorkflowInfo["runMode"];
  graph: WorkflowGraph;
};

/** A problem the core reports for a request, in words for the page. */
export function problemOf(error: unknown) {
  if (error instanceof CoreError) {
    if (error.code === "invalid_workflow") {
      return "It can't be saved as it is. Check the cards marked here.";
    }
    if (error.code === "not_found") {
      return "That automation is gone. It may have been deleted elsewhere.";
    }
    return `${productName} ran into a problem. Try again.`;
  }
  return `Can't reach ${productName}. Try again.`;
}

export function useAutomations(live: LiveFeed) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>();
  const [pieces, setPieces] = useState<PieceInfo[]>();
  const [entities, setEntities] = useState<EntityInfo[]>([]);
  // Who ran a workflow by hand, for its history.
  const [people, setPeople] = useState<PersonInfo[]>([]);
  const [problem, setProblem] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [nextWorkflows, nextPieces, nextEntities, nextPeople] =
        await Promise.all([
          coreJson<WorkflowInfo[]>("/api/workflows"),
          coreJson<PieceInfo[]>("/api/workflows/pieces"),
          // Names for what configs and runs name; the list works without.
          coreJson<EntityInfo[]>("/api/entities").catch(() => []),
          coreJson<PersonInfo[]>("/api/people").catch(() => []),
        ]);
      setWorkflows(nextWorkflows);
      setPieces(nextPieces);
      setEntities(nextEntities);
      setPeople(nextPeople);
      setProblem(undefined);
    } catch (error) {
      setProblem(problemOf(error));
    }
  }, []);

  useEffect(() => {
    void load();
    return live.subscribe({
      message() {},
      refresh: () => void load(),
    });
  }, [live, load]);

  // Each change answers with the workflow as it now is.
  const replace = useCallback((workflow: WorkflowInfo) => {
    setWorkflows((current) =>
      current?.some((each) => each.id === workflow.id)
        ? current.map((each) => (each.id === workflow.id ? workflow : each))
        : [...(current ?? []), workflow],
    );
    return workflow;
  }, []);

  const actions = useMemo(
    () => ({
      add: (workflow: NewWorkflow) =>
        coreJson<WorkflowInfo>("/api/workflows/add", {
          method: "POST",
          json: workflow,
        }).then(replace),
      update: (changes: Partial<NewWorkflow> & { id: string }) =>
        coreJson<WorkflowInfo>("/api/workflows/update", {
          method: "POST",
          json: changes,
        }).then(replace),
      remove: async (id: string) => {
        await coreJson("/api/workflows/remove", {
          method: "POST",
          json: { id },
        });
        setWorkflows((current) => current?.filter((each) => each.id !== id));
      },
      run: async (id: string) => {
        const run = await coreJson<WorkflowRunInfo>("/api/workflows/run", {
          method: "POST",
          json: { id },
        });
        // Its last run and status come with the list.
        void load();
        return run;
      },
      runs: (id: string) =>
        coreJson<WorkflowRunInfo[]>(
          `/api/workflows/runs?workflow=${encodeURIComponent(id)}`,
        ),
    }),
    [load, replace],
  );

  return { workflows, pieces, entities, people, problem, load, ...actions };
}

export type Automations = ReturnType<typeof useAutomations>;

/** What a config's ids are called in this home. */
export function namesOf(
  places: Places | undefined,
  devices: readonly DeviceInfo[],
  apps: readonly AppInfo[],
  entities: readonly EntityInfo[],
): Names {
  return {
    room: (id) => places?.rooms.find((room) => room.id === id)?.name,
    zone: (id) => places?.zones.find((zone) => zone.id === id)?.name,
    device: (id) => {
      const device = devices.find((each) => each.id === id);
      return (
        device && {
          name: device.name,
          kinds: device.capabilities.map((capability) => capability.kind),
        }
      );
    },
    entity: (type, key) =>
      entities.find((each) => each.type === type && each.key === key)?.name,
    app: (id) => apps.find((app) => app.id === id)?.name,
  };
}

/** A piece by the node that uses it. */
export function pieceOf(
  pieces: readonly PieceInfo[] | undefined,
  node: { kind: string; app?: string; piece: string },
) {
  return pieces?.find(
    (piece) =>
      piece.kind === node.kind &&
      piece.id === node.piece &&
      piece.app === (node.app ?? null),
  );
}
