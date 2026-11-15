CREATE TABLE `device_facts` (
	`mac` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`encrypted` integer NOT NULL,
	`version` text,
	`signal` real,
	`unused` text NOT NULL,
	`sleeps` integer NOT NULL
);
