/**
 * İşletim ölçümleri ucu (YOL_HARITASI §11).
 *
 * Kanıtlanan davranış:
 * - Uç `users.manage` ister; arşiv sorumlusu bile göremez (kurum geneli sayılar).
 * - Boş sistemde sayılar sıfır, yüzdelikler null döner — örnek yokken uydurma
 *   P50/P95 üretilmez.
 * - Kabul süresi oturum açılışından ACCEPTED olayına ölçülür; P50/P95 bilinen
 *   örneklemde doğru hesaplanır. Oturum durumları, tür reddi, yeniden denenen
 *   parça ve erişim reddi sayıları defterlerden doğru türetilir.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { transitionIngestSession } = await import("../lib/ingest-events.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const MANAGER = "sorumlu@sivas.bel.tr";
const UNIT = "İmar ve Şehircilik Müdürlüğü";

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/operations-metrics",
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Sorumlu', 'archive_manager', ?, 1)`).bind(MANAGER, UNIT).run();
    await run(server);
  } finally {
    await server.close();
  }
}

/** Bilinen açılış→kabul süresiyle ACCEPTED oturum kurar (gerçek geçiş servisiyle). */
async function seedAcceptedSession(server: NodeServer, options: { key: string; openedAt: string; acceptedAt: string; byteSize: number }) {
  const id = `oturum-${options.key}`;
  await server.db.prepare(`INSERT INTO upload_sessions (id, user_id, unit, original_name,
      requested_document_type, idempotency_key, status, state_version, expected_byte_size,
      declared_media_type, expires_at, created_at, updated_at)
    VALUES (?, 'memur@sivas.bel.tr', ?, ?, 'Tasnif bekliyor', ?, 'CREATED', 0, ?,
      'application/pdf', ?, ?, ?)`)
    .bind(id, UNIT, `${options.key}.pdf`, `idem-${options.key}`, options.byteSize,
      options.acceptedAt, options.openedAt, options.openedAt).run();
  const walk = ["UPLOADING", "QUARANTINED", "SCANNING", "VERIFIED", "PROMOTING", "ACCEPTED"] as const;
  for (const to of walk) {
    await transitionIngestSession(server.db, {
      sessionId: id, to,
      actor: { kind: "service", id: "test-hatti" },
      now: to === "ACCEPTED" ? options.acceptedAt : options.openedAt,
    });
  }
  return id;
}

test("işletim ölçümleri yönetim yetkisi ister", async () => {
  await withServer(async (server) => {
    const forbidden = await fetch(`${server.url}/api/operations`, {
      headers: { "oai-authenticated-user-email": MANAGER },
    });
    assert.equal(forbidden.status, 403, "arşiv sorumlusu kurum geneli metrikleri göremez");
  });
});

test("boş sistemde sayılar sıfır, yüzdelikler null", async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/api/operations`, {
      headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      sessions: { active: number }; promotion: { verified7d: number };
      intake: { sampled7d: number; durationP50Seconds: number | null };
    };
    assert.equal(payload.sessions.active, 0);
    assert.equal(payload.promotion.verified7d, 0);
    assert.equal(payload.intake.sampled7d, 0);
    assert.equal(payload.intake.durationP50Seconds, null, "örnek yokken yüzdelik uydurulmaz");
  });
});

test("kabul süresi, oturum durumları ve red sayıları defterlerden doğru türetilir", async () => {
  await withServer(async (server) => {
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

    // İki kabul: 60 sn ve 600 sn süren → P50=60, P95=600.
    const fast = await seedAcceptedSession(server, {
      key: "m1", openedAt: iso(2 * 3600_000 + 60_000), acceptedAt: iso(2 * 3600_000), byteSize: 1024 * 1024,
    });
    await seedAcceptedSession(server, {
      key: "m2", openedAt: iso(3600_000 + 600_000), acceptedAt: iso(3600_000), byteSize: 8 * 1024 * 1024,
    });
    // Aktif bir yükleme + yeniden denenmiş bir parça.
    await server.db.prepare(`INSERT INTO upload_sessions (id, user_id, unit, original_name,
        requested_document_type, idempotency_key, status, state_version, expected_byte_size,
        declared_media_type, expires_at, created_at, updated_at)
      VALUES ('oturum-m3', 'memur@sivas.bel.tr', ?, 'm3.pdf', 'Tasnif bekliyor', 'idem-m3',
        'UPLOADING', 0, 2048, 'application/pdf', ?, ?, ?)`)
      .bind(UNIT, iso(-3600_000), iso(600_000), iso(600_000)).run();
    await server.db.prepare(`INSERT INTO upload_parts (id, upload_session_id, part_number,
        byte_size, checksum_sha256, provider_part_token, status, attempt_count, created_at, updated_at)
      VALUES ('parca-m3', 'oturum-m3', 1, 1024, ?, 'jeton', 'UPLOADED', 2, ?, ?)`)
      .bind("b".repeat(64), iso(600_000), iso(600_000)).run();
    // Tür uyuşmazlığı reddi (7 gün içinde).
    await server.db.prepare(`INSERT INTO ingest_receipts (id, upload_session_id, result, sha256,
        byte_size, declared_media_type, detected_media_type, type_validation_result, parser_name,
        parser_version, parser_result, scanner_engine, scanner_version, scanner_signature_version,
        scanner_result, created_at)
      VALUES ('alindi-m3', 'oturum-m3', 'REJECTED', ?, 2048, 'application/pdf', 'image/png',
        'MISMATCH', 'qpdf', '1', 'INVALID', 'clamav', '1', '1', 'CLEAN', ?)`)
      .bind("c".repeat(64), iso(600_000)).run();
    // Erişim izi: bir bilet + bir ret (belge kaydı FK ister).
    await server.db.prepare(`INSERT INTO archive_documents (id, reference_no, original_name,
        storage_key, media_type, byte_size, sha256, document_type, unit, status, uploaded_by,
        created_at, updated_at)
      VALUES ('belge-m', 'ARS-2026-M', 'm.pdf', 'k-m', 'application/pdf', 2048, ?, 'Tasnif bekliyor',
        ?, 'review', 'memur@sivas.bel.tr', ?, ?)`)
      .bind("d".repeat(64), UNIT, iso(3600_000), iso(3600_000)).run();
    const auditRows: Array<[string, number, string]> = [
      ["document.ticket-issued", 1, iso(3000_000)],
      ["document.access-denied", 2, iso(1800_000)],
    ];
    for (const [action, eventNumber, at] of auditRows) {
      await server.db.prepare(`INSERT INTO audit_events (id, document_id, event_number, actor,
          action, details_json, previous_hash, event_hash, created_at)
        VALUES (?, 'belge-m', ?, 'test', ?, '{}', NULL, ?, ?)`)
        .bind(`olay-${eventNumber}`, eventNumber, action, `${eventNumber}`.repeat(64).slice(0, 64), at).run();
    }

    const response = await fetch(`${server.url}/api/operations`, {
      headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      sessions: { active: number; accepted7d: number };
      multipart: { parts7d: number; retriedParts7d: number };
      contentScan: { typeMismatch7d: number; malware7d: number };
      access: { denied24h: number; denied7d: number; ticketsIssued7d: number };
      intake: { sampled7d: number; durationP50Seconds: number; durationP95Seconds: number;
        byteSizeP50: number; byteSizeP95: number };
    };
    assert.equal(payload.sessions.active, 1);
    assert.equal(payload.sessions.accepted7d, 2);
    assert.equal(payload.multipart.parts7d, 1);
    assert.equal(payload.multipart.retriedParts7d, 1);
    assert.equal(payload.contentScan.typeMismatch7d, 1);
    assert.equal(payload.contentScan.malware7d, 0);
    assert.equal(payload.access.ticketsIssued7d, 1);
    assert.equal(payload.access.denied24h, 1);
    assert.equal(payload.access.denied7d, 1);
    assert.equal(payload.intake.sampled7d, 2);
    assert.equal(payload.intake.durationP50Seconds, 60, "P50 hızlı kabulün süresi olmalı");
    assert.equal(payload.intake.durationP95Seconds, 600, "P95 yavaş kabulün süresi olmalı");
    assert.equal(payload.intake.byteSizeP50, 1024 * 1024);
    assert.equal(payload.intake.byteSizeP95, 8 * 1024 * 1024);
    assert.ok(fast, "hızlı oturum kuruldu");
  });
});
