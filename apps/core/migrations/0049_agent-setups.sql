CREATE TABLE `auth_agent_setups` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`name` text NOT NULL,
	`added_by_kind` text NOT NULL,
	`added_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`wrong_secrets` integer DEFAULT 0 NOT NULL,
	`failed_at` integer,
	`cancelled_at` integer,
	`client_id` text,
	`collected_from` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_agent_setups_secret_hash_unique` ON `auth_agent_setups` (`secret_hash`);