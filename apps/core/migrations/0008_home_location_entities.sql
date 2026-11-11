CREATE TABLE `entities` (
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`household_safe` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `entities_type` ON `entities` (`type`);--> statement-breakpoint
ALTER TABLE `home` ADD `latitude` real;--> statement-breakpoint
ALTER TABLE `home` ADD `longitude` real;--> statement-breakpoint
ALTER TABLE `home` ADD `time_zone` text;