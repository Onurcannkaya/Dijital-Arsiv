CREATE TABLE `archive_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`reference_no` text NOT NULL,
	`original_name` text NOT NULL,
	`storage_key` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`document_type` text DEFAULT 'Tasnif bekliyor' NOT NULL,
	`unit` text DEFAULT 'Belirlenmedi' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_documents_reference_no_unique` ON `archive_documents` (`reference_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_documents_storage_key_unique` ON `archive_documents` (`storage_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_documents_sha256_unique` ON `archive_documents` (`sha256`);--> statement-breakpoint
CREATE INDEX `archive_documents_status_idx` ON `archive_documents` (`status`);--> statement-breakpoint
CREATE INDEX `archive_documents_created_at_idx` ON `archive_documents` (`created_at`);--> statement-breakpoint
CREATE TABLE `processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`kind` text DEFAULT 'ocr' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`model` text DEFAULT 'paddleocr-local' NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `archive_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `processing_jobs_status_created_idx` ON `processing_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `processing_jobs_document_idx` ON `processing_jobs` (`document_id`);