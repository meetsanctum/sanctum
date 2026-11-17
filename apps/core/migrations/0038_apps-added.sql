CREATE TABLE `apps_added` (
	`app_id` text PRIMARY KEY NOT NULL,
	`added_at` integer NOT NULL,
	`person_id` text,
	`client_id` text
);
--> statement-breakpoint
CREATE TABLE `apps_listed` (
	`id` integer PRIMARY KEY NOT NULL,
	`since` integer NOT NULL
);
