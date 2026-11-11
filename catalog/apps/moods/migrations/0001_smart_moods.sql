ALTER TABLE `moods` ADD `definition_id` text;--> statement-breakpoint
ALTER TABLE `moods` ADD `brightness` integer;--> statement-breakpoint
ALTER TABLE `moods` ADD `off_lights` text;--> statement-breakpoint
CREATE UNIQUE INDEX `moods_room_definition` ON `moods` (`room_id`,`definition_id`);