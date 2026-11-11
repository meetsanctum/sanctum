ALTER TABLE `app_updates` ADD `restores` text;--> statement-breakpoint
ALTER TABLE `app_updates` ADD `chosen` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_versions` ADD `settings_before` text;