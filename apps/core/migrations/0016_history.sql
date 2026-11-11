CREATE TABLE `history_compiled` (
	`period` text PRIMARY KEY NOT NULL,
	`through` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`kept` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `history_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`kind` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_series_capability` ON `history_series` (`device_id`,`capability_id`);--> statement-breakpoint
CREATE TABLE `history_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`at` integer NOT NULL,
	`availability` text NOT NULL,
	`state` text,
	FOREIGN KEY (`series_id`) REFERENCES `history_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_states_series_at` ON `history_states` (`series_id`,`at`);--> statement-breakpoint
CREATE INDEX `history_states_at` ON `history_states` (`at`);--> statement-breakpoint
CREATE TABLE `history_statistics` (
	`series_id` integer NOT NULL,
	`period` text NOT NULL,
	`start` integer NOT NULL,
	`field` text NOT NULL,
	`mean` real NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	`seconds` integer NOT NULL,
	PRIMARY KEY(`series_id`, `period`, `start`, `field`),
	FOREIGN KEY (`series_id`) REFERENCES `history_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_statistics_period_start` ON `history_statistics` (`period`,`start`);