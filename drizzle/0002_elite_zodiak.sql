CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`event_number` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`previous_hash` text,
	`event_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `archive_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_document_number_unique` ON `audit_events` (`document_id`,`event_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_hash_unique` ON `audit_events` (`event_hash`);--> statement-breakpoint
CREATE INDEX `audit_events_document_created_idx` ON `audit_events` (`document_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'Denetim kaydı değiştirilemez');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'Denetim kaydı silinemez');
END;