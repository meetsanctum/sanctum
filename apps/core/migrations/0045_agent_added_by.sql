ALTER TABLE `auth_clients` ADD `added_by_person_id` text REFERENCES people(id);--> statement-breakpoint
ALTER TABLE `auth_clients` ADD `added_by_client_id` text REFERENCES auth_clients(id);