ALTER TABLE `auth_invites` ADD `last_tried_at` integer;--> statement-breakpoint
ALTER TABLE `auth_invites` DROP COLUMN `key_stretching`;