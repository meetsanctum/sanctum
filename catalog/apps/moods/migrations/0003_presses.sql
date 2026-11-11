CREATE TABLE `presses` (
	`device_id` text NOT NULL,
	`action` text NOT NULL,
	`choice` text NOT NULL,
	PRIMARY KEY(`device_id`, `action`)
);
