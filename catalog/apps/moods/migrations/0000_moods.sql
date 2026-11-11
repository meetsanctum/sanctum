CREATE TABLE `mood_lights` (
	`mood_id` text NOT NULL,
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`mood_id`, `device_id`, `capability_id`),
	FOREIGN KEY (`mood_id`) REFERENCES `moods`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `moods` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `moods_room` ON `moods` (`room_id`,`position`);