DROP INDEX `auth_invites_person_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_invites_person_id_kind` ON `auth_invites` (`person_id`,`kind`);