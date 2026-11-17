CREATE TABLE `apps_removed` (
	`app_id` text PRIMARY KEY NOT NULL,
	`removed_at` integer NOT NULL,
	`person_id` text,
	`client_id` text,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`is_done` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflows_off_for_apps` (
	`workflow_id` text NOT NULL,
	`app` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workflow_id`, `app`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
