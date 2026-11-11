CREATE TABLE `motion_settings` (
	`room_id` text PRIMARY KEY NOT NULL,
	`turn_on` integer DEFAULT false NOT NULL,
	`darker_than` integer,
	`turn_off_after` integer
);
