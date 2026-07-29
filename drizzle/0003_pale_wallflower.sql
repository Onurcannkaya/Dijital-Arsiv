CREATE TABLE `archive_users` (
	`email` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`unit` text DEFAULT '*' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CHECK (`role` IN ('admin', 'archive_manager', 'reviewer', 'viewer')),
	CHECK (`active` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `archive_users_role_idx` ON `archive_users` (`role`);--> statement-breakpoint
CREATE INDEX `archive_users_unit_idx` ON `archive_users` (`unit`);