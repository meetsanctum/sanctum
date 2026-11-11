CREATE TABLE `followed_lights` (
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`since` integer NOT NULL,
	`paused_at` integer,
	`applied` text,
	`applied_at` integer,
	PRIMARY KEY(`device_id`, `capability_id`)
);
