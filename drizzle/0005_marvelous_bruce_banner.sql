CREATE TABLE `text_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`revision_number` integer NOT NULL,
	`previous_sha256` text NOT NULL,
	`text_sha256` text NOT NULL,
	`revised_text` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `archive_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_revisions_document_page_revision_unique` ON `text_revisions` (`document_id`,`page_number`,`revision_number`);--> statement-breakpoint
CREATE INDEX `text_revisions_document_created_idx` ON `text_revisions` (`document_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `ocr_pages` ADD `confirmed_text` text;--> statement-breakpoint
ALTER TABLE `ocr_pages` ADD `confirmed_by` text;--> statement-breakpoint
ALTER TABLE `ocr_pages` ADD `confirmed_at` text;