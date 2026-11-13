CREATE TABLE `app_secrets` (
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`sealed` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `name`)
);
