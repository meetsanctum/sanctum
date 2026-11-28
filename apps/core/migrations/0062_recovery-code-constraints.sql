PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auth_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`lookup` text NOT NULL,
	`registration_record` text NOT NULL,
	`key_stretching` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`tries` integer DEFAULT 0 NOT NULL,
	`last_tried_at` integer,
	`ended_reason` text,
	`ended_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_invites_ordinary_expiry" CHECK("__new_auth_invites"."kind" = 'recovery' OR "__new_auth_invites"."expires_at" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_auth_invites`("id", "person_id", "kind", "lookup", "registration_record", "key_stretching", "created_at", "expires_at", "tries", "last_tried_at", "ended_reason", "ended_at") SELECT "id", "person_id", "kind", "lookup", "registration_record", "key_stretching", "created_at", "expires_at", "tries", "last_tried_at", "ended_reason", "ended_at" FROM `auth_invites`;--> statement-breakpoint
DROP TABLE `auth_invites`;--> statement-breakpoint
ALTER TABLE `__new_auth_invites` RENAME TO `auth_invites`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_lookup_unique` ON `auth_invites` (`lookup`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_person_id_ordinary` ON `auth_invites` (`person_id`) WHERE kind <> 'recovery';--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_person_id_recovery` ON `auth_invites` (`person_id`) WHERE kind = 'recovery';