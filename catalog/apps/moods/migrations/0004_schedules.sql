CREATE TABLE `scheduled_moods` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`mood_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	FOREIGN KEY (`mood_id`) REFERENCES `moods`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_moods_room` ON `scheduled_moods` (`room_id`,`start`);--> statement-breakpoint
CREATE TABLE `snapshot_lights` (
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`state` text NOT NULL,
	`taken_at` text NOT NULL,
	PRIMARY KEY(`target_kind`, `target_id`, `device_id`, `capability_id`)
);
--> statement-breakpoint
CREATE TABLE `turn_on_entities` (
	`room_id` text PRIMARY KEY NOT NULL,
	`state` text,
	`household_safe` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn_on_settings` (
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`behaviour` text NOT NULL,
	PRIMARY KEY(`target_kind`, `target_id`)
);
