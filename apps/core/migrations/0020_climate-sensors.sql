ALTER TABLE `devices` ADD `battery` integer;--> statement-breakpoint
ALTER TABLE `home` ADD `temperature_unit` text DEFAULT 'celsius' NOT NULL;