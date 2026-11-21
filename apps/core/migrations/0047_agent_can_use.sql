CREATE TABLE `agent_areas` (
	`area` text PRIMARY KEY NOT NULL,
	`on` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_items` (
	`app_id` text NOT NULL,
	`item_id` text NOT NULL,
	`on` integer NOT NULL,
	`tier` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `item_id`)
);
