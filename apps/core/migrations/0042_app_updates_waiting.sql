CREATE TABLE `app_updates_waiting` (
	`app_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`version` text NOT NULL,
	`folder` text NOT NULL,
	`needs` text NOT NULL,
	`since` integer NOT NULL
);
