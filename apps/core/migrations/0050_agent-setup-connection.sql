ALTER TABLE `auth_agent_setups` ADD `connected_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_agent_setups_client_id` ON `auth_agent_setups` (`client_id`);