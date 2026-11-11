CREATE TABLE `app_grants` (
	`app_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `permission`)
);
