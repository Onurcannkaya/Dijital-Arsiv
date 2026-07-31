/**
 * F1.9 — Tek kullanımlık erişim bileti ve görüntüleme oturumu testleri.
 *
 * Kabul ölçütleri (YOL_HARITASI_FAZLAR.md §F1.9, kanıt rehberi T-05):
 * - süresi dolmuş veya tüketilmiş bilet reddedilir;
 * - bilet/oturum başka kullanıcı, belge veya kapsamda kullanılamaz;
 * - oturum boşta kalma penceresi mutlak süreyi aşamaz;
 * - veritabanında açık token değil yalnız özet durur.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ACCESS_SESSION_ABSOLUTE_MS,
  ACCESS_SESSION_IDLE_MS,
  ACCESS_TICKET_TTL_SECONDS,
  AccessTicketError,
  consumeDownloadTicket,
  exchangeViewTicket,
  issueAccessTicket,
  touchViewSession,
} from "../lib/access-tickets.ts";
import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const START = new Date("2026-07-31T10:00:00.000Z");

function fixture() {
  const db = createSqliteD1();
  let nowMs = START.getTime();
  return {
    db,
    now: () => new Date(nowMs),
    advance(ms: number) { nowMs += ms; },
  };
}

type Fixture = ReturnType<typeof fixture>;

function seedDocument(target: Fixture, id: string) {
  // Kısmi benzersiz indeks (original SHA) nedeniyle belge başına farklı SHA üretilir.
  const originalSha = createHash("sha256").update(`asil-${id}`).digest("hex");
  const accessSha = createHash("sha256").update(`turev-${id}`).digest("hex");
  target.db.raw.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
    VALUES (?, ?, 'belge.pdf', ?, 'application/pdf', 10, ?, 'user@sivas.bel.tr')`)
    .run(id, `ARS-${id}`, `originals/${id}/asil`, originalSha);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256)
    VALUES (?, ?, 'original', ?, 'application/pdf', 10, ?)`)
    .run(`orj-${id}`, id, `originals/${id}/asil`, originalSha);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256, bucket_or_namespace)
    VALUES (?, ?, 'access', ?, 'application/pdf', 8, ?, 'DERIVATIVE_FILES')`)
    .run(`acc-${id}`, id, `derivatives/${id}/access/turev`, accessSha);
  return { originalId: `orj-${id}`, accessId: `acc-${id}` };
}

const USER = "memur@sivas.bel.tr";

async function issueView(target: Fixture, binaryObjectId: string) {
  return await issueAccessTicket(target.db, {
    userId: USER, documentId: "d1", binaryObjectId, scope: "VIEW",
    purpose: "DOCUMENT_REVIEW", now: target.now,
  });
}

function rejects(code: "TICKET_INVALID" | "SESSION_INVALID") {
  return (error: unknown) => error instanceof AccessTicketError && error.code === code;
}

test("VIEW bileti tek sefer tüketilir, oturum açılır ve açık token saklanmaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    const issued = await issueView(target, objects.accessId);

    const stored = target.db.raw.prepare("SELECT ticket_hash FROM access_tickets").get() as { ticket_hash: string };
    assert.notEqual(stored.ticket_hash, issued.token, "veritabanı yalnız özet tutar");
    assert.match(stored.ticket_hash, /^[a-f0-9]{64}$/);

    const exchanged = await exchangeViewTicket(target.db, {
      token: issued.token, userId: USER, documentId: "d1", now: target.now,
    });
    assert.equal(exchanged.ticket.object_class, "access");
    assert.equal(exchanged.ticket.bucket_or_namespace, "DERIVATIVE_FILES");
    assert.equal(exchanged.session.absoluteExpiresAt,
      new Date(START.getTime() + ACCESS_SESSION_ABSOLUTE_MS).toISOString());

    const sessionRow = target.db.raw.prepare("SELECT session_hash, object_class FROM access_sessions").get() as Record<string, string>;
    assert.notEqual(sessionRow.session_hash, exchanged.session.token);

    // Tüketilmiş bilet ikinci kez değiştirilemez.
    await assert.rejects(exchangeViewTicket(target.db, {
      token: issued.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));
  } finally {
    target.db.close();
  }
});

test("süresi dolan, iptal edilen veya yanlış bağlamda kullanılan bilet reddedilir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const d1 = seedDocument(target, "d1");
    seedDocument(target, "d2");

    // Yanlış kullanıcı/belge/kapsam: red edilir ama bilet YANMAZ; meşru sahibi kullanabilir.
    const bound = await issueView(target, d1.accessId);
    await assert.rejects(exchangeViewTicket(target.db, {
      token: bound.token, userId: "baskasi@sivas.bel.tr", documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));
    await assert.rejects(exchangeViewTicket(target.db, {
      token: bound.token, userId: USER, documentId: "d2", now: target.now,
    }), rejects("TICKET_INVALID"));
    await assert.rejects(consumeDownloadTicket(target.db, {
      token: bound.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));
    await exchangeViewTicket(target.db, {
      token: bound.token, userId: USER, documentId: "d1", now: target.now,
    });

    // Süre dolumu: 60 saniyelik pencerenin bir milisaniye sonrası geçersizdir.
    const expiring = await issueView(target, d1.accessId);
    target.advance(ACCESS_TICKET_TTL_SECONDS * 1000 + 1);
    await assert.rejects(exchangeViewTicket(target.db, {
      token: expiring.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));

    // İptal edilen bilet kullanılamaz.
    const revoked = await issueView(target, d1.accessId);
    target.db.raw.prepare("UPDATE access_tickets SET revoked_at = ? WHERE id = ?")
      .run(target.now().toISOString(), revoked.ticketId);
    await assert.rejects(exchangeViewTicket(target.db, {
      token: revoked.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));
  } finally {
    target.db.close();
  }
});

test("oturum boşta kalma penceresi ilerler ama mutlak süreyi aşamaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    const issued = await issueView(target, objects.accessId);
    const { session } = await exchangeViewTicket(target.db, {
      token: issued.token, userId: USER, documentId: "d1", now: target.now,
    });

    // 10'ar dakikalık kullanım: boşta kalma penceresi ilerler, mutlak tavana kırpılır.
    for (let step = 0; step < 2; step += 1) {
      target.advance(10 * 60 * 1000);
      const active = await touchViewSession(target.db, {
        token: session.token, userId: USER, documentId: "d1", now: target.now,
      });
      assert.ok(active.idle_expires_at <= session.absoluteExpiresAt,
        "boşta kalma penceresi mutlak süreyi aşamaz");
      assert.equal(active.object_class, "access");
    }

    // Mutlak süre (30 dk) dolunca boşta kalma penceresi açık olsa bile reddedilir.
    target.advance(10 * 60 * 1000 + 1000);
    await assert.rejects(touchViewSession(target.db, {
      token: session.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("SESSION_INVALID"));
  } finally {
    target.db.close();
  }
});

test("boşta kalan oturum ve yanlış kullanıcı/belge oturumu reddedilir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    seedDocument(target, "d2");
    const issued = await issueView(target, objects.accessId);
    const { session } = await exchangeViewTicket(target.db, {
      token: issued.token, userId: USER, documentId: "d1", now: target.now,
    });

    await assert.rejects(touchViewSession(target.db, {
      token: session.token, userId: "baskasi@sivas.bel.tr", documentId: "d1", now: target.now,
    }), rejects("SESSION_INVALID"));
    await assert.rejects(touchViewSession(target.db, {
      token: session.token, userId: USER, documentId: "d2", now: target.now,
    }), rejects("SESSION_INVALID"));

    target.advance(ACCESS_SESSION_IDLE_MS + 1000);
    await assert.rejects(touchViewSession(target.db, {
      token: session.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("SESSION_INVALID"));
  } finally {
    target.db.close();
  }
});

test("DOWNLOAD bileti asıla bağlanır, tek seferliktir ve oturum üretmez", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    const issued = await issueAccessTicket(target.db, {
      userId: USER, documentId: "d1", binaryObjectId: objects.originalId, scope: "DOWNLOAD",
      purpose: "ORIGINAL_DOWNLOAD", now: target.now,
    });
    const consumed = await consumeDownloadTicket(target.db, {
      token: issued.token, userId: USER, documentId: "d1", now: target.now,
    });
    assert.equal(consumed.object_class, "original");
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM access_sessions").get() as { count: number }).count, 0);
    await assert.rejects(consumeDownloadTicket(target.db, {
      token: issued.token, userId: USER, documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));
  } finally {
    target.db.close();
  }
});

test("VIEW asla asıl nesneye, DOWNLOAD asla türeve bağlanamaz ve amaç kodu kapalıdır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    await assert.rejects(issueAccessTicket(target.db, {
      userId: USER, documentId: "d1", binaryObjectId: objects.originalId,
      scope: "VIEW", purpose: "DOCUMENT_REVIEW", now: target.now,
    }), /uygun yetkili nesne/);
    await assert.rejects(issueAccessTicket(target.db, {
      userId: USER, documentId: "d1", binaryObjectId: objects.accessId,
      scope: "DOWNLOAD", purpose: "ORIGINAL_DOWNLOAD", now: target.now,
    }), /uygun yetkili nesne/);
    await assert.rejects(issueAccessTicket(target.db, {
      userId: USER, documentId: "d1", binaryObjectId: objects.accessId,
      scope: "VIEW", purpose: "ORIGINAL_DOWNLOAD", now: target.now,
    }), /kapsamla/);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM access_tickets")
      .get() as { count: number }).count, 0);
  } finally {
    target.db.close();
  }
});

test("oturum INSERT hatası bileti yakmaz; tüketim ve oturum tek atomik işlemdir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    const first = await issueView(target, objects.accessId);
    await exchangeViewTicket(target.db, {
      token: first.token, userId: USER, documentId: "d1", now: target.now,
      sessionId: "sabit-oturum",
    });

    const second = await issueView(target, objects.accessId);
    await assert.rejects(exchangeViewTicket(target.db, {
      token: second.token, userId: USER, documentId: "d1", now: target.now,
      sessionId: "sabit-oturum",
    }), rejects("TICKET_INVALID"));
    const row = target.db.raw.prepare("SELECT consumed_at FROM access_tickets WHERE id = ?")
      .get(second.ticketId) as { consumed_at: string | null };
    assert.equal(row.consumed_at, null, "başarısız oturum INSERT'i bilet tüketimini geri alır");
    assert.ok((await exchangeViewTicket(target.db, {
      token: second.token, userId: USER, documentId: "d1", now: target.now,
    })).session.token);
  } finally {
    target.db.close();
  }
});

test("biçimsiz veya aşırı kısa kimlik bilgisi özetlenmeden tek tip reddedilir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    seedDocument(target, "d1");
    await assert.rejects(exchangeViewTicket(target.db, {
      token: "kısa", userId: USER, documentId: "d1", now: target.now,
    }), rejects("TICKET_INVALID"));
    await assert.rejects(touchViewSession(target.db, {
      token: "x".repeat(10_000), userId: USER, documentId: "d1", now: target.now,
    }), rejects("SESSION_INVALID"));
  } finally {
    target.db.close();
  }
});

test("bilet bağlama alanları veritabanında değiştirilemez ve denetim serbest metin taşımaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const objects = seedDocument(target, "d1");
    const issued = await issueView(target, objects.accessId);
    const ticket = target.db.raw.prepare(`SELECT document_id, object_class, purpose
      FROM access_tickets WHERE id = ?`).get(issued.ticketId) as Record<string, string>;
    assert.equal(ticket.document_id, "d1");
    assert.equal(ticket.object_class, "access");
    assert.equal(ticket.purpose, "DOCUMENT_REVIEW");
    assert.throws(() => target.db.raw.prepare(
      "UPDATE access_tickets SET object_class = 'original' WHERE id = ?",
    ).run(issued.ticketId));
    const audit = target.db.raw.prepare(
      "SELECT details_json FROM audit_events WHERE action = 'document.ticket-issued'",
    ).get() as { details_json: string };
    assert.ok(audit.details_json.includes("DOCUMENT_REVIEW"));
    assert.ok(!audit.details_json.includes("belge inceleme"));
  } finally {
    target.db.close();
  }
});
