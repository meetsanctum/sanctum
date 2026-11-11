ALTER TABLE `activity` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `activity` ADD `client_name` text;--> statement-breakpoint
ALTER TABLE `activity` ADD `app` text;--> statement-breakpoint
ALTER TABLE `activity` ADD `cause_id` text;--> statement-breakpoint
ALTER TABLE `activity` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `activity` ADD `count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `activity` ADD `first_at` integer;--> statement-breakpoint
CREATE INDEX `activity_subject` ON `activity` (`subject_id`,`at`);--> statement-breakpoint
CREATE INDEX `activity_kind` ON `activity` (`kind`,`at`);--> statement-breakpoint
CREATE INDEX `activity_cause` ON `activity` (`cause_id`);