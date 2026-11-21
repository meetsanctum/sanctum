PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`person_id` text,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	`added_by_person_id` text,
	`added_by_client_id` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_client_id`) REFERENCES `auth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_clients_person" CHECK(("__new_auth_clients"."kind" = 'personal') = ("__new_auth_clients"."person_id" is not null)),
	CONSTRAINT "auth_clients_added_by" CHECK((("__new_auth_clients"."added_by_person_id" is not null) + ("__new_auth_clients"."added_by_client_id" is not null)) = ("__new_auth_clients"."kind" = 'agent'))
);
--> statement-breakpoint
INSERT INTO `__new_auth_clients`("id", "name", "kind", "person_id", "platform", "created_at", "created_by", "added_by_person_id", "added_by_client_id", "last_seen_at", "revoked_at") SELECT "id", "name", "kind", "person_id", "platform", "created_at", "created_by", "added_by_person_id", "added_by_client_id", "last_seen_at", "revoked_at" FROM `auth_clients`;--> statement-breakpoint
DROP TABLE `auth_clients`;--> statement-breakpoint
ALTER TABLE `__new_auth_clients` RENAME TO `auth_clients`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `activity` ADD `agent_added_by` text;