CREATE TABLE `mood_entities` (
	`mood_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`state` text,
	`household_safe` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mood_entities_room` ON `mood_entities` (`room_id`);