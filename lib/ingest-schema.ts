/**
 * Faz 1 kabul hattının sağlayıcıdan bağımsız D1 şeması.
 *
 * `ingest_objects` kabul öncesi temporary/quarantine nesnelerinin;
 * `binary_objects` ise kabul edilmiş nesnelerin yetkili envanteridir.
 */
export const ingestTableStatements: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    user_id TEXT NOT NULL,
    unit TEXT NOT NULL,
    original_name TEXT NOT NULL,
    requested_document_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CREATED',
    state_version INTEGER NOT NULL DEFAULT 0,
    in_flight_parts INTEGER NOT NULL DEFAULT 0,
    parts_lease_expires_at TEXT,
    expected_byte_size INTEGER NOT NULL,
    uploaded_byte_size INTEGER NOT NULL DEFAULT 0,
    declared_media_type TEXT NOT NULL,
    detected_media_type TEXT,
    provider_upload_token TEXT,
    duplicate_of_document_id TEXT REFERENCES archive_documents(id),
    failure_code TEXT,
    operator_retry_reason TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status IN ('CREATED', 'UPLOADING', 'QUARANTINED', 'SCANNING', 'VERIFIED', 'PROMOTING', 'ACCEPTED', 'REJECTED', 'DUPLICATE', 'EXPIRED', 'FAILED')),
    CHECK (state_version >= 0),
    CHECK (in_flight_parts BETWEEN 0 AND 4),
    CHECK (expected_byte_size BETWEEN 1 AND 2147483648),
    CHECK (uploaded_byte_size BETWEEN 0 AND expected_byte_size),
    CHECK ((status = 'DUPLICATE' AND duplicate_of_document_id IS NOT NULL) OR status <> 'DUPLICATE')
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_idempotency_unique ON upload_sessions (tenant_id, user_id, idempotency_key)",
  "CREATE INDEX IF NOT EXISTS upload_sessions_status_expiry_idx ON upload_sessions (status, expires_at)",

  `CREATE TABLE IF NOT EXISTS upload_parts (
    id TEXT PRIMARY KEY NOT NULL,
    upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    provider_part_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UPLOADED',
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (part_number BETWEEN 1 AND 10000),
    CHECK (byte_size > 0),
    CHECK (length(checksum_sha256) = 64),
    CHECK (status IN ('UPLOADED', 'VERIFIED', 'REPLACED', 'FAILED')),
    CHECK (attempt_count >= 1)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS upload_parts_session_number_unique ON upload_parts (upload_session_id, part_number)",
  "CREATE INDEX IF NOT EXISTS upload_parts_session_status_idx ON upload_parts (upload_session_id, status)",

  `CREATE TABLE IF NOT EXISTS ingest_objects (
    id TEXT PRIMARY KEY NOT NULL,
    upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    object_class TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    storage_provider TEXT NOT NULL,
    bucket_or_namespace TEXT NOT NULL,
    storage_version_id TEXT,
    provider_etag TEXT,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    -- temporary/quarantine SHA tam nesne SCANNING öncesi akışla okunana kadar bilinmeyebilir.
    sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    CHECK (object_class IN ('temporary', 'quarantine')),
    CHECK (byte_size >= 0),
    CHECK (sha256 IS NULL OR length(sha256) = 64)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS ingest_objects_session_class_unique ON ingest_objects (upload_session_id, object_class) WHERE deleted_at IS NULL",
  "CREATE INDEX IF NOT EXISTS ingest_objects_class_created_idx ON ingest_objects (object_class, created_at)",

  `CREATE TABLE IF NOT EXISTS ingest_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    declared_media_type TEXT NOT NULL,
    detected_media_type TEXT NOT NULL,
    type_validation_result TEXT NOT NULL,
    scanner_engine TEXT NOT NULL,
    scanner_version TEXT NOT NULL,
    scanner_signature_version TEXT NOT NULL,
    scanner_result TEXT NOT NULL,
    vault_storage_version_id TEXT,
    vault_sha256 TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (result IN ('VERIFIED', 'REJECTED', 'FAILED')),
    CHECK (length(sha256) = 64),
    CHECK (byte_size > 0),
    CHECK (type_validation_result IN ('MATCH', 'MISMATCH', 'UNSUPPORTED')),
    CHECK (scanner_result IN ('CLEAN', 'MALICIOUS', 'ERROR')),
    CHECK (vault_sha256 IS NULL OR length(vault_sha256) = 64)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS ingest_receipts_session_verified_unique ON ingest_receipts (upload_session_id) WHERE result = 'VERIFIED'",
  "CREATE INDEX IF NOT EXISTS ingest_receipts_result_created_idx ON ingest_receipts (result, created_at)",
  `CREATE TRIGGER IF NOT EXISTS ingest_receipts_no_update
    BEFORE UPDATE ON ingest_receipts BEGIN SELECT RAISE(ABORT, 'Ingest receipt is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ingest_receipts_no_delete
    BEFORE DELETE ON ingest_receipts BEGIN SELECT RAISE(ABORT, 'Ingest receipt is immutable'); END`,

  `CREATE TABLE IF NOT EXISTS integrity_runs (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING',
    cursor TEXT,
    checked_count INTEGER NOT NULL DEFAULT 0,
    finding_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    CHECK (checked_count >= 0),
    CHECK (finding_count >= 0)
  )`,
  "CREATE INDEX IF NOT EXISTS integrity_runs_status_started_idx ON integrity_runs (status, started_at)",
  `CREATE TABLE IF NOT EXISTS integrity_findings (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES integrity_runs(id) ON DELETE CASCADE,
    binary_object_id TEXT REFERENCES binary_objects(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    expected_sha256 TEXT,
    actual_sha256 TEXT,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    CHECK (finding_type IN ('MISSING', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'UNREADABLE')),
    CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED'))
  )`,
  "CREATE INDEX IF NOT EXISTS integrity_findings_run_status_idx ON integrity_findings (run_id, status)",
  "CREATE INDEX IF NOT EXISTS integrity_findings_object_idx ON integrity_findings (binary_object_id)",

  `CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING',
    cursor TEXT,
    checked_count INTEGER NOT NULL DEFAULT 0,
    finding_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    CHECK (checked_count >= 0),
    CHECK (finding_count >= 0)
  )`,
  "CREATE INDEX IF NOT EXISTS reconciliation_runs_status_started_idx ON reconciliation_runs (status, started_at)",
  `CREATE TABLE IF NOT EXISTS reconciliation_findings (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
    record_kind TEXT NOT NULL,
    record_id TEXT,
    object_key TEXT,
    finding_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    CHECK (record_kind IN ('INGEST_OBJECT', 'BINARY_OBJECT', 'ARCHIVE_DOCUMENT', 'STORAGE_OBJECT')),
    CHECK (finding_type IN ('ORPHAN_OBJECT', 'MISSING_OBJECT', 'MISSING_RECORD', 'METADATA_MISMATCH')),
    CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
    CHECK (record_id IS NOT NULL OR object_key IS NOT NULL)
  )`,
  "CREATE INDEX IF NOT EXISTS reconciliation_findings_run_status_idx ON reconciliation_findings (run_id, status)",
  `CREATE TABLE IF NOT EXISTS upload_session_events (
    id TEXT PRIMARY KEY NOT NULL,
    upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    event_number INTEGER NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT,
    ingest_receipt_id TEXT REFERENCES ingest_receipts(id),
    event_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (event_number >= 1),
    CHECK (from_status IN ('CREATED', 'UPLOADING', 'QUARANTINED', 'SCANNING', 'VERIFIED', 'PROMOTING', 'ACCEPTED', 'REJECTED', 'DUPLICATE', 'EXPIRED', 'FAILED')),
    CHECK (to_status IN ('CREATED', 'UPLOADING', 'QUARANTINED', 'SCANNING', 'VERIFIED', 'PROMOTING', 'ACCEPTED', 'REJECTED', 'DUPLICATE', 'EXPIRED', 'FAILED')),
    CHECK (actor_kind IN ('user', 'operator', 'service')),
    CHECK (length(trim(actor_id)) > 0),
    CHECK (length(event_hash) = 64),
    CHECK (from_status <> 'FAILED' OR to_status <> 'PROMOTING' OR (actor_kind = 'operator' AND length(trim(reason)) > 0 AND ingest_receipt_id IS NOT NULL))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS upload_session_events_number_unique ON upload_session_events (upload_session_id, event_number)",
  "CREATE INDEX IF NOT EXISTS upload_session_events_transition_idx ON upload_session_events (from_status, to_status, created_at)",
  `CREATE TRIGGER IF NOT EXISTS upload_session_events_no_update
    BEFORE UPDATE ON upload_session_events BEGIN SELECT RAISE(ABORT, 'Kabul denetim olayı değiştirilemez'); END`,
  `CREATE TRIGGER IF NOT EXISTS upload_session_events_no_delete
    BEFORE DELETE ON upload_session_events BEGIN SELECT RAISE(ABORT, 'Kabul denetim olayı silinemez'); END`,

  `CREATE TRIGGER IF NOT EXISTS upload_session_events_retry_evidence_guard
    BEFORE INSERT ON upload_session_events
    WHEN NEW.from_status = 'FAILED' AND NEW.to_status = 'PROMOTING'
      AND (NOT EXISTS (
        SELECT 1 FROM ingest_receipts r
        WHERE r.id = NEW.ingest_receipt_id
          AND r.upload_session_id = NEW.upload_session_id
          AND r.result = 'VERIFIED' AND r.scanner_result = 'CLEAN'
      ) OR NOT EXISTS (
        SELECT 1 FROM ingest_objects o
        WHERE o.upload_session_id = NEW.upload_session_id
          AND o.object_class = 'quarantine' AND o.deleted_at IS NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'Operator retry evidence is incomplete'); END`,
  `CREATE TRIGGER IF NOT EXISTS upload_sessions_no_delete
    BEFORE DELETE ON upload_sessions BEGIN SELECT RAISE(ABORT, 'Ingest session is retained as audit evidence'); END`,  `CREATE TRIGGER IF NOT EXISTS upload_sessions_transition_guard
    BEFORE UPDATE OF status, state_version ON upload_sessions
    WHEN NOT (
      (NEW.status = OLD.status AND NEW.state_version = OLD.state_version)
      OR (
        NEW.status <> OLD.status
        AND NEW.state_version = OLD.state_version + 1
        AND EXISTS (
          SELECT 1 FROM upload_session_events e
          WHERE e.upload_session_id = OLD.id
            AND e.event_number = NEW.state_version
            AND e.from_status = OLD.status
            AND e.to_status = NEW.status
        )
        AND (
          (OLD.status = 'CREATED' AND NEW.status IN ('UPLOADING', 'EXPIRED'))
          OR (OLD.status = 'UPLOADING' AND NEW.status IN ('QUARANTINED', 'EXPIRED', 'FAILED'))
          OR (OLD.status = 'QUARANTINED' AND NEW.status IN ('SCANNING', 'EXPIRED', 'FAILED'))
          OR (OLD.status = 'SCANNING' AND NEW.status IN ('VERIFIED', 'REJECTED', 'FAILED'))
          OR (OLD.status = 'VERIFIED' AND NEW.status IN ('PROMOTING', 'DUPLICATE', 'EXPIRED'))
          OR (OLD.status = 'PROMOTING' AND NEW.status IN ('ACCEPTED', 'FAILED'))
          OR (OLD.status = 'FAILED' AND NEW.status = 'PROMOTING')
        )
      )
    )
    BEGIN SELECT RAISE(ABORT, 'Invalid ingest state transition'); END`,
  `CREATE TABLE IF NOT EXISTS access_tickets (
    id TEXT PRIMARY KEY NOT NULL,
    ticket_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    binary_object_id TEXT NOT NULL REFERENCES binary_objects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (scope IN ('VIEW', 'DOWNLOAD')),
    CHECK (length(ticket_hash) = 64),
    CHECK (length(trim(purpose)) > 0)
  )`,
  "CREATE INDEX IF NOT EXISTS access_tickets_user_expiry_idx ON access_tickets (user_id, expires_at)",
  "CREATE INDEX IF NOT EXISTS access_tickets_object_idx ON access_tickets (binary_object_id)",
];
