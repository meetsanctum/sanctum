CREATE TABLE `device_capabilities` (
	`device_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`features` text NOT NULL,
	`observed` text,
	`desired` text,
	`sync` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`driver` text NOT NULL,
	`key` text NOT NULL,
	`driver_name` text NOT NULL,
	`name` text,
	`manufacturer` text,
	`model` text,
	`room_id` text,
	`household_safe` integer NOT NULL,
	`availability` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_driver_key` ON `devices` (`driver`,`key`);--> statement-breakpoint
CREATE INDEX `devices_room_id` ON `devices` (`room_id`);--> statement-breakpoint
CREATE TABLE `floors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`level` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `home` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`floor_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`floor_id`) REFERENCES `floors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rooms_floor_id` ON `rooms` (`floor_id`);--> statement-breakpoint
CREATE TABLE `zone_rooms` (
	`zone_id` text NOT NULL,
	`room_id` text NOT NULL,
	PRIMARY KEY(`zone_id`, `room_id`),
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `zone_rooms_room_id` ON `zone_rooms` (`room_id`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
