CREATE TABLE `app_updates` (
	`app_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`from_version` text NOT NULL,
	`from_folder` text NOT NULL,
	`to_version` text NOT NULL,
	`to_folder` text NOT NULL,
	`status` text NOT NULL,
	`settings` text NOT NULL,
	`failure` text,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_versions` ADD `folder` text;