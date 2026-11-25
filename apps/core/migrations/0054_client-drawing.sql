ALTER TABLE `auth_clients` ADD `reduce_effects` text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_clients` ADD `reduce_motion` text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_clients` ADD `drawing_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_clients` ADD `drawn` text;