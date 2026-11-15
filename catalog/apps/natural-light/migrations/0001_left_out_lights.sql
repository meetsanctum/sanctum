CREATE TABLE `left_out_lights` (
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	PRIMARY KEY(`device_id`, `capability_id`)
);
