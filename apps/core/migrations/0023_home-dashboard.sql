CREATE TABLE `home_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `dashboards` ADD `kind` text DEFAULT 'custom' NOT NULL;