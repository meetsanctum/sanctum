CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`person_id` text,
	`client_id` text,
	`subject_id` text,
	`address` text
);
--> statement-breakpoint
CREATE INDEX `activity_at` ON `activity` (`at`);--> statement-breakpoint
CREATE TABLE `auth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`person_id` text,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_clients_person" CHECK(("auth_clients"."kind" = 'personal') = ("auth_clients"."person_id" is not null))
);
--> statement-breakpoint
CREATE TABLE `auth_logins` (
	`person_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`registration_record` text NOT NULL,
	`key_stretching` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_logins_username_unique` ON `auth_logins` (`username`);--> statement-breakpoint
CREATE TABLE `auth_server` (
	`id` integer PRIMARY KEY NOT NULL,
	`server_setup` text NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `auth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_token_hash_unique` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_client_id` ON `auth_tokens` (`client_id`);