/**
 * F1.7 — PDF erişim türevi orkestrasyonu testleri.
 *
 * Kabul ölçütleri (YOL_HARITASI_FAZLAR.md §F1.7):
 * - PDF görüntüleme hiçbir durumda `original` sınıfına düşmez;
 * - türev `derived_from_id`, üretici sürümü ve sayfa aralığıyla yazılır;
 * - geri dolum idempotenttir; başarısız işler retry/dead-letter görünür;
 * - bölümleme sınır aşan belgeleri görüntülenebilir tutar.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { isPendingDerivative, resolveViewableObject } from "../lib/binary-objects.ts";
import { processNextDerivativeJob, type RenderedSegment } from "../lib/document-render.ts";
import {
  MemoryNamespace,
  MemoryObjectReader,
  MemoryStagingStorage,
  createNodeStreamingHasher,
} from "./memory-object-storage.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function fixture() {
  const db = createSqliteD1();
  const vault = new MemoryNamespace(() => NOW);
  let sequence = 0;
  return {
    db,
    vault,
    staging: new MemoryStagingStorage(vault),
    reader: new MemoryObjectReader(vault),
    hasher: createNodeStreamingHasher(),
    randomId: () => `id-${++sequence}`,
  };
}

type Fixture = ReturnType<typeof fixture>;

function seedAcceptedDocument(target: Fixture, id: string, mediaType = "application/pdf") {
  const key = `originals/${id}/object`;
  const digest = sha256(`asıl-${id}`);
  target.db.raw.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
    VALUES (?, ?, 'belge.pdf', ?, ?, 10, ?, 'user@sivas.bel.tr')`)
    .run(id, `ARS-${id}`, key, mediaType, digest);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256)
    VALUES (?, ?, 'original', ?, ?, 10, ?)`)
    .run(`obj-${id}`, id, key, mediaType, digest);
  return { key, digest, sourceId: `obj-${id}` };
}

/** Gerçek servisi taklit eder: bölümleri depoya yazar, kanıtları döndürür. */
function fakeRenderService(target: Fixture, plan: Array<{ pages: [number, number]; content: string }>, options: {
  pageCount: number;
  tamperSha?: boolean;
  reviewRequired?: string;
  imageDigest?: string;
}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /\/v1\/render$/);
    const body = JSON.parse(String(init?.body)) as {
      renderId: string; documentId: string; objectKey: string; sha256: string;
    };
    if (options.reviewRequired) {
      return Response.json({ detail: { code: "REVIEW_REQUIRED", message: options.reviewRequired } }, { status: 422 });
    }
    const segments: RenderedSegment[] = [];
    for (const [index, entry] of plan.entries()) {
      const key = `derivatives/${body.documentId}/access/${body.renderId}/part-${String(index + 1).padStart(4, "0")}.pdf`;
      await target.staging.put(key, entry.content, { contentType: "application/pdf" });
      segments.push({
        objectKey: key,
        pageStart: entry.pages[0],
        pageEnd: entry.pages[1],
        byteSize: new TextEncoder().encode(entry.content).byteLength,
        sha256: options.tamperSha ? "0".repeat(64) : sha256(entry.content),
      });
    }
    return Response.json({
      renderId: body.renderId,
      renderer: "pdfium",
      rendererVersion: "141.0",
      rendererImageDigest: options.imageDigest ?? IMAGE_DIGEST,
      profileVersion: "access-pdf-v1",
      pageCount: options.pageCount,
      segments,
    });
  }) as typeof fetch;
}

function dependencies(target: Fixture, fetcher: typeof fetch) {
  return {
    db: target.db,
    derivativeReader: target.reader,
    hasher: target.hasher,
    serviceUrl: "https://render.internal",
    serviceToken: "test-token",
    expectedImageDigest: IMAGE_DIGEST,
    now: () => NOW,
    randomId: target.randomId,
    fetcher,
  };
}

test("bölümlü türev doğrulanıp sayfa aralığı ve üreticiyle kaydedilir; geri dolum idempotenttir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const seeded = seedAcceptedDocument(target, "cok-sayfali");
    const fetcher = fakeRenderService(target, [
      { pages: [1, 2], content: "bölüm bir içeriği" },
      { pages: [3, 3], content: "bölüm iki içeriği" },
    ], { pageCount: 3 });

    const result = await processNextDerivativeJob(dependencies(target, fetcher));
    assert.equal(result.result, "COMPLETED");
    assert.equal(result.segments, 2);

    const rows = target.db.raw.prepare(`SELECT object_key, bucket_or_namespace, derived_from_id, generator,
      derivative_generation_id, page_start, page_end, sha256
      FROM binary_objects WHERE object_class = 'access' ORDER BY page_start`).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => [row.page_start, row.page_end]), [[1, 2], [3, 3]]);
    assert.ok(rows.every((row) => row.derived_from_id === seeded.sourceId));
    assert.ok(rows.every((row) => row.generator === "pdfium:141.0:access-pdf-v1"));
    assert.ok(rows.every((row) => row.bucket_or_namespace === "DERIVATIVE_FILES"));
    assert.equal(new Set(rows.map((row) => row.derivative_generation_id)).size, 1);

    const job = target.db.raw.prepare(`SELECT status, renderer_image_digest, page_count, segment_count
      FROM derivative_jobs`).get() as Record<string, unknown>;
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.renderer_image_digest, IMAGE_DIGEST);
    assert.equal(job.page_count, 3);
    assert.equal(job.segment_count, 2);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, 1);

    // Asıl nesnenin kaydı değişmedi (T-03'ün yerel aynası).
    const original = target.db.raw.prepare(
      "SELECT object_key, sha256 FROM binary_objects WHERE object_class = 'original'",
    ).get() as Record<string, string>;
    assert.equal(original.object_key, seeded.key);
    assert.equal(original.sha256, seeded.digest);

    // Görüntüleme bölümleri sırayla sunar; asıl sınıfına düşmez.
    const first = await resolveViewableObject(target.db, "cok-sayfali");
    assert.ok(first && !isPendingDerivative(first));
    assert.equal(first.objectClass, "access");
    assert.deepEqual(first.segment, { index: 1, total: 2 });
    const second = await resolveViewableObject(target.db, "cok-sayfali", 2);
    assert.ok(second && !isPendingDerivative(second) && second.object.page_start === 3);
    assert.equal(await resolveViewableObject(target.db, "cok-sayfali", 3), null,
      "geçersiz bölüm son bölüme sessizce sıkıştırılmamalı");

    // Aynı generator dizesini kullanan tamamlanmamış başka kuşak segmentleri
    // görüntüleme seçimine karışamaz.
    target.db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, bucket_or_namespace, media_type,
       byte_size, sha256, derived_from_id, generator, page_start, page_end,
       derivative_generation_id, created_at)
      VALUES ('rogue', 'cok-sayfali', 'access', 'derivatives/cok-sayfali/access/rogue/part-0001.pdf',
       'DERIVATIVE_FILES', 'application/pdf', 1, ?, ?, 'pdfium:141.0:access-pdf-v1',
       1, 99, 'rogue-generation', '2099-01-01T00:00:00Z')`)
      .run("b".repeat(64), seeded.sourceId);
    const afterRogue = await resolveViewableObject(target.db, "cok-sayfali");
    assert.ok(afterRogue && !isPendingDerivative(afterRogue));
    assert.equal(afterRogue.object.derivative_generation_id, rows[0].derivative_generation_id);

    // Geri dolum idempotent: tamamlanan aktif profil yeniden kuyruğa girmez.
    const again = await processNextDerivativeJob(dependencies(target, fetcher));
    assert.equal(again.processed, false);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM derivative_jobs").get() as { count: number }).count, 1);

    // Yeni profil, eski kanıtı ezmeden aynı belge için ayrı iş açabilir.
    target.db.raw.prepare(`INSERT INTO derivative_jobs
      (id, document_id, source_binary_object_id, profile_version)
      VALUES ('profile-v2-job', 'cok-sayfali', ?, 'access-pdf-v2')`).run(seeded.sourceId);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM derivative_jobs").get() as { count: number }).count, 2);
  } finally {
    target.db.close();
  }
});

test("yazma sonrası SHA uyuşmazlığı kayıt üretmez ve iş yeniden denemeye düşer", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    seedAcceptedDocument(target, "sha-bozuk");
    const fetcher = fakeRenderService(target, [{ pages: [1, 1], content: "içerik" }], {
      pageCount: 1,
      tamperSha: true,
    });

    const result = await processNextDerivativeJob(dependencies(target, fetcher));
    assert.equal(result.result, "RETRY");
    const job = target.db.raw.prepare("SELECT status, attempt, next_attempt_at FROM derivative_jobs").get() as Record<string, unknown>;
    assert.equal(job.status, "RETRY");
    assert.equal(job.attempt, 1);
    assert.ok(job.next_attempt_at);
    assert.equal((target.db.raw.prepare(
      "SELECT COUNT(*) AS count FROM binary_objects WHERE object_class = 'access'",
    ).get() as { count: number }).count, 0);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count, 0);
  } finally {
    target.db.close();
  }
});

test("beklenmeyen renderer imaj özeti fail-closed kalır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    seedAcceptedDocument(target, "yanlis-imaj");
    const fetcher = fakeRenderService(target, [{ pages: [1, 1], content: "içerik" }], {
      pageCount: 1,
      imageDigest: `sha256:${"c".repeat(64)}`,
    });
    const result = await processNextDerivativeJob(dependencies(target, fetcher));
    assert.equal(result.result, "RETRY");
    assert.equal((target.db.raw.prepare(
      "SELECT COUNT(*) AS count FROM binary_objects WHERE object_class = 'access'",
    ).get() as { count: number }).count, 0);
  } finally {
    target.db.close();
  }
});

test("REVIEW_REQUIRED kalıcıdır ve PDF görüntüleme asla asıla düşmez", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    seedAcceptedDocument(target, "parolali");
    const fetcher = fakeRenderService(target, [], { pageCount: 1, reviewRequired: "PDF açılamadı" });

    const result = await processNextDerivativeJob(dependencies(target, fetcher));
    assert.equal(result.result, "REVIEW_REQUIRED");
    const job = target.db.raw.prepare(
      "SELECT status, failure_code, next_attempt_at FROM derivative_jobs",
    ).get() as Record<string, unknown>;
    assert.equal(job.status, "REVIEW_REQUIRED");
    assert.equal(job.failure_code, "REVIEW_REQUIRED");
    assert.equal(job.next_attempt_at, null, "inceleme gerektiren iş otomatik tekrar edilmez");

    // Türev yokken PDF görüntüleme asıl sunmaz; bekleme bildirir.
    const view = await resolveViewableObject(target.db, "parolali");
    assert.ok(view && isPendingDerivative(view));

    // PDF dışı türlerde asıl fallback geçici olarak sürer (görsel türevleri OCR üretir).
    seedAcceptedDocument(target, "gorsel", "image/jpeg");
    const imageView = await resolveViewableObject(target.db, "gorsel");
    assert.ok(imageView && !isPendingDerivative(imageView));
    assert.equal(imageView.objectClass, "original");

    // Görsel belge PDF geri dolum kuyruğuna girmez; REVIEW_REQUIRED de yeniden alınmaz.
    const idle = await processNextDerivativeJob(dependencies(target, fetcher));
    assert.equal(idle.processed, false);
    const jobs = target.db.raw.prepare("SELECT document_id FROM derivative_jobs").all() as Array<{ document_id: string }>;
    assert.deepEqual(jobs.map((row) => row.document_id), ["parolali"]);
  } finally {
    target.db.close();
  }
});
