CREATE TABLE `model_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`model_name` text NOT NULL,
	`computer` text,
	`host` text,
	`port` integer,
	`sealed_key` text,
	`key_end` text,
	`in_use` integer NOT NULL,
	`check` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_tokens` (
	`day` text NOT NULL,
	`source_id` text NOT NULL,
	`used_by` text NOT NULL,
	`tokens` integer NOT NULL,
	PRIMARY KEY(`day`, `source_id`, `used_by`)
);
