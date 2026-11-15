import type { Job, JobRequest, WorkflowInfo } from "@meetsanctum/app-sdk";

// What apps hand the core's Workflows module: the events they emit, which
// workflows follow, and the jobs and workflows the module keeps for them.

/** An event an app emitted, as the core hands it on. */
export type EmittedEvent = {
  id: string;
  app: string;
  event: string;
  payload: unknown;
  at: Date;
};

/** Apps' jobs, which the Workflows module keeps. */
export type JobCalls = {
  schedule(appId: string, job: JobRequest): Job;
  cancel(appId: string, key: string): void;
  list(appId: string): Job[];
};

/** The workflows apps keep, which the Workflows module keeps for them. */
export type KeptWorkflowCalls = {
  put(appId: string, workflow: unknown): WorkflowInfo;
  remove(appId: string, key: string): void;
  // Inside a commit's transaction; what it answers runs once that has committed.
  sweep(appId: string, claimed: ReadonlySet<string>): () => void;
  list(appId: string): WorkflowInfo[];
};
