CREATE TABLE `auth_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`lookup` text NOT NULL,
	`registration_record` text NOT NULL,
	`key_stretching` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`last_tried_at` integer,
	`ended_reason` text,
	`ended_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_person_id_unique` ON `auth_invites` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_lookup_unique` ON `auth_invites` (`lookup`);