CREATE TABLE `system_restores` (
	`id` text PRIMARY KEY NOT NULL,
	`restored_at` integer NOT NULL,
	`backup_at` integer,
	`dismissed_at` integer,
	`dismissed_by` text
);
