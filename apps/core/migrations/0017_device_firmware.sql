ALTER TABLE `devices` ADD `firmware` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `probe` integer DEFAULT false NOT NULL;