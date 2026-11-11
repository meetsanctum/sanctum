CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`app` text NOT NULL,
	`key` text NOT NULL,
	`action` text NOT NULL,
	`input` text,
	`when` text NOT NULL,
	`next_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_app_key` ON `jobs` (`app`,`key`);--> statement-breakpoint
CREATE INDEX `jobs_next_at` ON `jobs` (`next_at`);--> statement-breakpoint
CREATE TABLE `workflow_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`node` text NOT NULL,
	`kind` text NOT NULL,
	`app` text,
	`piece` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_run_steps_run` ON `workflow_run_steps` (`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`started_by` text,
	`reason` text,
	`error` text,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow` ON `workflow_runs` (`workflow_id`,`queued_at`);--> statement-breakpoint
CREATE TABLE `workflow_timers` (
	`workflow_id` text NOT NULL,
	`node` text NOT NULL,
	`next_at` integer,
	PRIMARY KEY(`workflow_id`, `node`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_timers_next_at` ON `workflow_timers` (`next_at`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`run_mode` text NOT NULL,
	`graph` text NOT NULL,
	`version` integer NOT NULL,
	`created_by` text,
	`app` text,
	`app_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_app_key` ON `workflows` (`app`,`app_key`);--> statement-breakpoint
ALTER TABLE `activity` ADD `actor` text;