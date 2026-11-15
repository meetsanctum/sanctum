CREATE TABLE `place_sensing` (
	`place` text NOT NULL,
	`kind` text NOT NULL,
	`answering` integer NOT NULL,
	`active` integer NOT NULL,
	`inactive_since` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`place`, `kind`)
);
