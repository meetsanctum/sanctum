CREATE TABLE `auth_pairing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`device_secret_hash` text NOT NULL,
	`platform` text NOT NULL,
	`suggested_name` text NOT NULL,
	`source_address` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`name` text,
	`client_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_pairing_requests_code_hash_unique` ON `auth_pairing_requests` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_pairing_requests_device_secret_hash_unique` ON `auth_pairing_requests` (`device_secret_hash`);