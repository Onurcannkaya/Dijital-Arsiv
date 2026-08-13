/**
 * Kullanıcı yönetimi ve yetki matrisi — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Bu alandaki kapsam bugüne dek kütüphane düzeyindeydi (`user-directory`), oysa
 * sahaya çıkan kusur rota düzeyinde oldu: kurum içi Node sunucusu `/api/users`
 * ucunu hiç kaydetmemişti ve kütüphane testleri bunu göremezdi.
 *
 * Burada ölçülen, rolün gerçekten KISITLAYIP kısıtlamadığıdır. Rol atamak
 * yalnız bir etiket yazmak değildir: belediye arşivinde belgeyi kimin
 * arşivleyebileceği ve kimin hangi müdürlüğü görebileceği bu matrise bağlıdır.
 *
 * Kapsanan kabuller:
 * - her rol yalnız kendi işlemlerini yapabilir;
 * - müdürlük kapsamı listeyi ve yazmayı süzer;
 * - erişimi kapatılan kullanıcı her uçtan anında reddedilir;
 * - kilitlenme korumaları (kendi rolünü düşürme, son yönetici) çalışır;
 * - kullanıcı silinmez, yalnız pasifleştirilir.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const IMAR = "İmar ve Şehircilik Müdürlüğü";
const RUHSAT = "Ruhsat ve Denetim Müdürlüğü";
const STAFF = {
  reviewer: "memur@sivas.bel.tr",
  manager: "mudur@sivas.bel.tr",
  viewer: "bakan@sivas.bel.tr",
};

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/kullanici",
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    // İki müdürlükte birer belge: kapsam süzmesi ancak farkla ölçülebilir.
    for (const [id, unit] of [["belge-imar", IMAR], ["belge-ruhsat", RUHSAT]] as const) {
      await server.db.prepare(`INSERT INTO archive_documents
          (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
           document_type, unit, status, uploaded_by, created_at, updated_at)
        VALUES (?, ?, 'tutanak.pdf', ?, 'application/pdf', 2048, ?, 'Numarataj tespit tutanağı',
          ?, 'review', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
        .bind(id, `ARS-2026-${id.toUpperCase()}`, `test/${id}`, id.padEnd(64, "b"), unit, ADMIN).run();
    }
    await run(server);
  } finally {
    await server.close();
  }
}

type Json = Record<string, unknown> & { error?: string; code?: string };

const call = async (server: NodeServer, actor: string, path: string, init: RequestInit = {}) => {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), "oai-authenticated-user-email": actor },
  });
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};

const JSON_HEADER = { "content-type": "application/json" };

const addUser = (server: NodeServer, email: string, role: string, unit: string) =>
  call(server, ADMIN, "/api/users", {
    method: "POST", headers: JSON_HEADER,
    body: JSON.stringify({ email, displayName: email, role, unit }),
  });

async function seedStaff(server: NodeServer) {
  assert.equal((await addUser(server, STAFF.reviewer, "reviewer", IMAR)).status, 201);
  assert.equal((await addUser(server, STAFF.manager, "archive_manager", RUHSAT)).status, 201);
  assert.equal((await addUser(server, STAFF.viewer, "viewer", "*")).status, 201);
}

test("rol gerçekten kısıtlar: her uç yalnız yetkili role açıktır", async () => {
  await withServer(async (server) => {
    await seedStaff(server);

    /*
     * Rol atamak yalnız etiket yazmak değildir. Belgeyi kimin arşivleyebileceği
     * — geri alınamaz adım — ve yönetim ekranlarını kimin açabileceği buraya
     * bağlıdır; matris kayarsa kimse fark etmez, çünkü ekranlar yine açılır.
     */
    const attempts: Array<[label: string, path: string, init: RequestInit]> = [
      ["belge listesi", "/api/documents", {}],
      ["kullanıcı yönetimi", "/api/users", {}],
      ["ayarlar", "/api/settings", {}],
      ["arşivleme", "/api/documents/belge-imar/approve", { method: "POST" }],
      ["OCR çalıştırma", "/api/jobs/process?documentId=belge-imar", { method: "POST" }],
    ];
    // Beklenen: `true` = yetkili (403 DEĞİL), `false` = rol yüzünden reddedilir.
    const expected: Record<string, boolean[]> = {
      // liste, kullanıcı, ayarlar, arşivleme, OCR
      [STAFF.viewer]: [true, false, false, false, false],
      [STAFF.reviewer]: [true, false, false, false, false],
      [STAFF.manager]: [true, false, false, true, true],
      [ADMIN]: [true, true, true, true, true],
    };

    for (const [actor, allowed] of Object.entries(expected)) {
      for (const [index, [label, path, init]] of attempts.entries()) {
        const response = await call(server, actor, path, init);
        const roleRefused = response.status === 403
          && /rolünüz için yetkili değildir/.test(response.body.error ?? "");
        assert.equal(!roleRefused, allowed[index], `${actor} → ${label} (${response.status})`);
      }
    }
  });
});

test("müdürlük kapsamı listeyi ve yazmayı süzer", async () => {
  await withServer(async (server) => {
    await seedStaff(server);

    const scoped = await call(server, STAFF.reviewer, "/api/documents");
    const units = (scoped.body.documents as Array<{ unit: string }>).map((entry) => entry.unit);
    assert.deepEqual([...new Set(units)], [IMAR], "kapsam dışı belge listeye sızdı");

    // Kapsam dışı belgeye yazma denemesi listeleme kadar sessiz olmamalı:
    // memur belgenin var olduğunu değil, kapsamı dışında olduğunu öğrenir.
    const foreign = await call(server, STAFF.reviewer, "/api/documents/belge-ruhsat/fields", {
      method: "PATCH", headers: JSON_HEADER,
      body: JSON.stringify({ values: [{ id: "x", action: "confirm" }] }),
    });
    assert.equal(foreign.status, 403);
    assert.match(foreign.body.error ?? "", /müdürlük kapsamınızın dışında/);

    // Yönetici bütün müdürlükleri görür.
    const all = await call(server, ADMIN, "/api/documents");
    assert.equal((all.body.documents as unknown[]).length, 2);

    // Kapsam değişikliği anında geçerlidir.
    assert.equal((await call(server, ADMIN, "/api/users", {
      method: "PATCH", headers: JSON_HEADER,
      body: JSON.stringify({ email: STAFF.reviewer, unit: RUHSAT }),
    })).status, 200);
    const moved = await call(server, STAFF.reviewer, "/api/documents");
    assert.deepEqual([...new Set((moved.body.documents as Array<{ unit: string }>).map((e) => e.unit))], [RUHSAT]);
  });
});

test("erişimi kapatılan kullanıcı her uçtan anında reddedilir", async () => {
  await withServer(async (server) => {
    await seedStaff(server);
    assert.equal((await call(server, STAFF.reviewer, "/api/documents")).status, 200);

    assert.equal((await call(server, ADMIN, "/api/users", {
      method: "PATCH", headers: JSON_HEADER,
      body: JSON.stringify({ email: STAFF.reviewer, active: false }),
    })).status, 200);

    // Kapatma yalnız listeyi değil kimliği de kapatır; yarım kalan bir oturum
    // yazma yapmaya devam edememelidir.
    for (const path of ["/api/me", "/api/documents", "/api/overview"]) {
      const refused = await call(server, STAFF.reviewer, path);
      assert.equal(refused.status, 403, path);
      assert.match(refused.body.error ?? "", /erişim yetkiniz bulunmuyor/);
    }

    // Yeniden açılınca erişim geri gelir; kayıt silinmediği için geçmiş korunur.
    assert.equal((await call(server, ADMIN, "/api/users", {
      method: "PATCH", headers: JSON_HEADER,
      body: JSON.stringify({ email: STAFF.reviewer, active: true }),
    })).status, 200);
    assert.equal((await call(server, STAFF.reviewer, "/api/documents")).status, 200);
  });
});

test("kilitlenme korumaları yöneticiyi kapıda bırakmaz", async () => {
  await withServer(async (server) => {
    await seedStaff(server);
    assert.equal((await addUser(server, "ikinci@sivas.bel.tr", "admin", "*")).status, 201);

    const patch = (actor: string, body: unknown) => call(server, actor, "/api/users", {
      method: "PATCH", headers: JSON_HEADER, body: JSON.stringify(body),
    });

    // Yönetici kendi erişimini kapatamaz ve kendi rolünü düşüremez: devir
    // başka bir yönetici eliyle yapılır, böylece kaza sonucu kimse kalmaz.
    const selfOff = await patch("ikinci@sivas.bel.tr", { email: "ikinci@sivas.bel.tr", active: false });
    assert.equal(selfOff.status, 409);
    assert.equal(selfOff.body.code, "SELF_DEACTIVATION");
    const selfDown = await patch("ikinci@sivas.bel.tr", { email: "ikinci@sivas.bel.tr", role: "viewer" });
    assert.equal(selfDown.status, 409);
    assert.equal(selfDown.body.code, "SELF_DEMOTION");

    // Devir çalışır ve devredilen yönetim yetkisini kaybeder.
    assert.equal((await patch(ADMIN, { email: "ikinci@sivas.bel.tr", role: "reviewer" })).status, 200);
    assert.equal((await call(server, "ikinci@sivas.bel.tr", "/api/users")).status, 403);
  });
});

test("kullanıcı silinmez; mükerrer ve geçersiz kayıt reddedilir", async () => {
  await withServer(async (server) => {
    await seedStaff(server);

    // Denetim izi kullanıcıyı e-postasıyla anar; silme kaydı sahipsiz bırakır.
    const deleted = await call(server, ADMIN, "/api/users", {
      method: "DELETE", headers: JSON_HEADER, body: JSON.stringify({ email: STAFF.viewer }),
    });
    assert.equal(deleted.status, 405);

    const rejected: Array<[label: string, body: unknown, code: string]> = [
      ["mükerrer e-posta", { email: STAFF.viewer, role: "viewer", unit: "*" }, "USER_EXISTS"],
      ["geçersiz e-posta", { email: "eposta-degil", role: "viewer", unit: "*" }, "INVALID_EMAIL"],
      ["geçersiz rol", { email: "yeni@sivas.bel.tr", role: "kral", unit: "*" }, "INVALID_ROLE"],
      ["sözlük dışı müdürlük", { email: "yeni@sivas.bel.tr", role: "viewer", unit: "Olmayan" }, "INVALID_UNIT"],
    ];
    for (const [label, body, code] of rejected) {
      const response = await call(server, ADMIN, "/api/users", {
        method: "POST", headers: JSON_HEADER, body: JSON.stringify(body),
      });
      assert.equal(response.body.code, code, label);
    }

    /*
     * E-posta normalleştirmesi Türkçe locale tuzağına düşmemelidir: `I`
     * `ı`ya inerse aynı kişi iki ayrı kayıt olur ve yetki ikiye bölünür.
     */
    assert.equal((await addUser(server, "ILHAN@sivas.bel.tr", "viewer", "*")).status, 201);
    const same = await call(server, ADMIN, "/api/users", {
      method: "POST", headers: JSON_HEADER,
      body: JSON.stringify({ email: "ilhan@sivas.bel.tr", role: "viewer", unit: "*" }),
    });
    assert.equal(same.body.code, "USER_EXISTS");
    // Kimlik başlığı da aynı biçime iner.
    const identity = await call(server, "ILHAN@sivas.bel.tr", "/api/me");
    assert.equal((identity.body.user as { email: string }).email, "ilhan@sivas.bel.tr");
  });
});

test("her yetki değişikliği değiştirilemez yönetim kaydına yazılır", async () => {
  await withServer(async (server) => {
    await seedStaff(server);
    await call(server, ADMIN, "/api/users", {
      method: "PATCH", headers: JSON_HEADER,
      body: JSON.stringify({ email: STAFF.viewer, role: "reviewer" }),
    });

    const events = await server.db.prepare(`SELECT actor, target_email, action, new_state
      FROM user_admin_events WHERE target_kind = 'user' ORDER BY created_at`)
      .all<{ actor: string; target_email: string; action: string; new_state: string }>();
    const rows = events.results ?? [];
    assert.equal(rows.filter((row) => row.action === "user.created").length, 3);
    const update = rows.find((row) => row.action === "user.updated");
    assert.equal(update?.target_email, STAFF.viewer);
    assert.equal(update?.actor, ADMIN);
    assert.match(update?.new_state ?? "", /"role":"reviewer"/);

    // Kayıt değiştirilemez ve silinemez.
    await assert.rejects(() => server.db.prepare("UPDATE user_admin_events SET actor = 'x'").run());
    await assert.rejects(() => server.db.prepare("DELETE FROM user_admin_events").run());
  });
});
