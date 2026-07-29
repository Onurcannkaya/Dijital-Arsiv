CREATE TABLE `extracted_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`field_name` text NOT NULL,
	`field_value` text NOT NULL,
	`normalized_value` text,
	`confidence` real NOT NULL,
	`page_number` integer NOT NULL,
	`bbox_json` text NOT NULL,
	`evidence_text` text NOT NULL,
	`model` text NOT NULL,
	`needs_review` integer DEFAULT true NOT NULL,
	`corrected_value` text,
	`corrected_by` text,
	`corrected_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `archive_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extracted_fields_document_name_unique` ON `extracted_fields` (`document_id`,`field_name`);--> statement-breakpoint
CREATE INDEX `extracted_fields_document_idx` ON `extracted_fields` (`document_id`);--> statement-breakpoint
CREATE INDEX `extracted_fields_review_idx` ON `extracted_fields` (`needs_review`);--> statement-breakpoint
CREATE TABLE `ocr_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`full_text` text DEFAULT '' NOT NULL,
	`words_json` text DEFAULT '[]' NOT NULL,
	`average_confidence` real DEFAULT 0 NOT NULL,
	`model` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `archive_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ocr_pages_document_page_unique` ON `ocr_pages` (`document_id`,`page_number`);--> statement-breakpoint
CREATE INDEX `ocr_pages_document_idx` ON `ocr_pages` (`document_id`);