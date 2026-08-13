/**
 * Ayarlardan sözlük yönetimi — ret gerekçeleri.
 *
 * Kurallar müdürlük listesiyle ortaktır ve tek yerde durur
 * (`lib/vocabulary-directory.ts`): kaldırma değil pasifleştirme, ve son aktif
 * terim korunur. İkincisi gerekçelerde daha da kritiktir — gerekçe zorunlu
 * olduğundan liste boşalırsa personel hiçbir ret kaydedemez hale gelir.
 *
 * Kapsanan kabuller:
 * - gerekçe eklenir, ret akışında hemen seçilebilir olur;
 * - pasifleştirme kaydı silmez ve geçmiş kararların gerekçesi korunur;
 * - son aktif gerekçe pasifleştirilemez;
 * - her değişiklik yönetim denetim kaydına yazılır;
 * - yetkisiz kullanıcı sözlüğü değiştiremez.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const CLERK = "memur@sivas.bel.tr";
const ADMIN_JSON = { "oai-authenticated-user-email": ADMIN, "content-type": "application/json" };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "belge-sozluk";
const VOCABULARY = "relation-rejection-reason";

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/sozluk",
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, unit, status, uploaded_by, created_at, updated_at)
      VALUES (?, 'ARS-2026-SZL', 'tutanak.pdf', 'test/szl', 'application/pdf', 2048, ?,
        'Numarataj tespit tutanağı', ?, 'review', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
      .bind(DOC, "a".repeat(64), UNIT, ADMIN).run();
    await run(server);
  } finally {
    await server.close();
  }
}

type SettingsBody = {
  error?: string; code?: string;
  vocabularies?: Array<{ key: string; name: string;
    terms: Array<{ code: string; label: string; active: boolean; usage: Array<{ label: string; count: number }> }> }>;
};

const settings = async (server: NodeServer, method: "GET" | "POST" | "PATCH", body?: unknown) => {
  const response = await fetch(`${server.url}/api/settings`, {
    method, headers: ADMIN_JSON, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) as SettingsBody };
};

const reasons = async (server: NodeServer) =>
  (await settings(server, "GET")).body.vocabularies?.find((entry) => entry.key === VOCABULARY);

const rejectRelation = async (server: NodeServer, relationId: string, reasonCode: string) => {
  const response = await fetch(`${server.url}/api/documents/${DOC}/relations`, {
    method: "PATCH", headers: ADMIN_JSON,
    body: JSON.stringify({ relations: [{ id: relationId, action: "reject", reasonCode }] }),
  });
  return response.status;
};

const addRelation = async (server: NodeServer) => {
  const response = await fetch(`${server.url}/api/documents/${DOC}/relations`, {
    method: "POST", headers: ADMIN_JSON,
    body: JSON.stringify({ parcel: { blockNo: "1284", parcelNo: "17", districtCode: "5801", cadastralNeighborhood: "KILAVUZ" } }),
  });
  const body = await response.json() as { relations?: Array<{ id: string; verificationStatus: string }> };
  return body.relations?.[0].id ?? "";
};

test("ayarlar ekranı yönetilebilir sözlükleri sunar", async () => {
  await withServer(async (server) => {
    const listed = (await settings(server, "GET")).body.vocabularies ?? [];
    assert.deepEqual(listed.map((entry) => entry.key).sort(),
      ["field-rejection-reason", "relation-rejection-reason"]);
    const relation = listed.find((entry) => entry.key === VOCABULARY);
    assert.ok(relation?.terms.some((term) => term.code === "WRONG_ENTITY"), "başlangıç kümesi görünmüyor");
    assert.ok(relation?.terms.every((term) => term.active), "tohum terimleri pasif geldi");
  });
});

test("eklenen gerekçe ret akışında hemen seçilebilir", async () => {
  await withServer(async (server) => {
    const created = await settings(server, "POST",
      { vocabulary: VOCABULARY, label: "Mahkeme kararıyla düşürüldü" });
    assert.equal(created.status, 201);

    const relationId = await addRelation(server);
    assert.equal(await rejectRelation(server, relationId, "MAHKEME_KARARIYLA_DUSURULDU"), 200);

    // Aynı ad ikinci kez eklenemez.
    const duplicate = await settings(server, "POST",
      { vocabulary: VOCABULARY, label: "Mahkeme kararıyla düşürüldü" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "REASON_EXISTS");

    // Geçersiz ad reddedilir.
    assert.equal((await settings(server, "POST", { vocabulary: VOCABULARY, label: "   " })).status, 400);
    assert.equal((await settings(server, "POST", { vocabulary: VOCABULARY, label: "!!!" })).status, 400);
    // Bilinmeyen sözlük hedeflenemez.
    assert.equal((await settings(server, "POST", { vocabulary: "olmayan", label: "X" })).status, 404);
  });
});

test("pasifleştirme kaydı silmez; geçmiş kararların gerekçesi korunur", async () => {
  await withServer(async (server) => {
    const relationId = await addRelation(server);
    assert.equal(await rejectRelation(server, relationId, "WRONG_ENTITY"), 200);

    // Kullanım sayısı pasifleştirme kararını bilgilendirir.
    const before = await reasons(server);
    const used = before?.terms.find((term) => term.code === "WRONG_ENTITY");
    assert.ok((used?.usage[0].count ?? 0) > 0, "kullanım sayısı görünmüyor");

    const disabled = await settings(server, "PATCH", { vocabulary: VOCABULARY, code: "WRONG_ENTITY", active: false });
    assert.equal(disabled.status, 200);

    // Terim listeden kaybolmaz, yalnız pasifleşir.
    const after = await reasons(server);
    const term = after?.terms.find((entry) => entry.code === "WRONG_ENTITY");
    assert.ok(term, "pasifleştirilen terim silinmiş");
    assert.equal(term.active, false);

    /*
     * Geçmiş karar gerekçesini korur: denetim izi değişmezdir ve etiket olayla
     * birlikte yazıldığından, terim listeden kalksa bile okunabilir kalır.
     */
    const event = await server.db.prepare(`SELECT details_json FROM audit_events
      WHERE document_id = ? AND action = 'relation.rejected' ORDER BY event_number DESC LIMIT 1`)
      .bind(DOC).first<{ details_json: string }>();
    assert.match(event?.details_json ?? "", /"reasonLabel":"Belge bu taşınmaza ait değil"/);

    // Yeni retlerde artık seçilemez.
    const other = await addRelation(server);
    assert.equal(await rejectRelation(server, other, "WRONG_ENTITY"), 400);
  });
});

test("son aktif gerekçe pasifleştirilemez", async () => {
  await withServer(async (server) => {
    const initial = await reasons(server);
    const codes = (initial?.terms ?? []).map((term) => term.code);
    assert.ok(codes.length > 1);

    // İlki hariç hepsi kapatılabilir. Hayatta kalan `OTHER` OLMAMALI: o
    // gerekçe açıklama zorunlu kıldığından ret yolunu tek başına temsil etmez.
    const survivor = codes.find((code) => code !== "OTHER") ?? codes[0];
    for (const code of codes.filter((code) => code !== survivor)) {
      assert.equal((await settings(server, "PATCH", { vocabulary: VOCABULARY, code, active: false })).status, 200, code);
    }
    /*
     * Gerekçe zorunlu olduğundan liste boşalırsa personel hiçbir ret
     * kaydedemez hale gelir: ekranda gerekçe seçeneği kalmaz ve sunucu her
     * reddi geri çevirir.
     */
    const last = await settings(server, "PATCH", { vocabulary: VOCABULARY, code: survivor, active: false });
    assert.equal(last.status, 409);
    assert.equal(last.body.code, "LAST_REASON");

    // Kalan gerekçeyle ret hâlâ kaydedilebilmeli.
    const relationId = await addRelation(server);
    assert.equal(await rejectRelation(server, relationId, survivor), 200);
  });
});

test("her sözlük değişikliği yönetim denetim kaydına yazılır", async () => {
  await withServer(async (server) => {
    await settings(server, "POST", { vocabulary: VOCABULARY, label: "Kurum içi devir" });
    await settings(server, "PATCH", { vocabulary: VOCABULARY, code: "DUPLICATE", active: false });
    // Durumu değiştirmeyen istek kayıt üretmemeli.
    await settings(server, "PATCH", { vocabulary: VOCABULARY, code: "DUPLICATE", active: false });

    const events = await server.db.prepare(`SELECT action, target_email, target_kind FROM user_admin_events
      WHERE target_kind = 'relation-rejection-reason' ORDER BY created_at`)
      .all<{ action: string; target_email: string; target_kind: string }>();
    assert.deepEqual((events.results ?? []).map((row) => `${row.action}:${row.target_email}`),
      ["rejection-reason.created:KURUM_ICI_DEVIR", "rejection-reason.updated:DUPLICATE"]);
  });
});

test("sözlük yönetimi yetki ister", async () => {
  await withServer(async (server) => {
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Memur', 'reviewer', ?, 1)`).bind(CLERK, UNIT).run();
    const forbidden = await fetch(`${server.url}/api/settings`, {
      method: "POST",
      headers: { "oai-authenticated-user-email": CLERK, "content-type": "application/json" },
      body: JSON.stringify({ vocabulary: VOCABULARY, label: "Memurun eklediği" }),
    });
    assert.equal(forbidden.status, 403);
  });
});

test("kurum içi sunucu her uygulama rotasını sunar", async () => {
  /*
   * Ayarlar, Kullanıcılar ve İşlem Geçmişi uçları Workers çalışma zamanına
   * eklenmiş ama Node sunucusuna bağlanmamıştı: ADR-018'in üretim hedefi kurum
   * içi Node dağıtımı olduğundan bu üç yönetim ekranı sahada 404 verirdi.
   * Eksiklik sessizce oluştu, bu yüzden karşılaştırma teste bağlanır.
   */
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../app/api/", import.meta.url);

  const routePaths: string[] = [];
  const walk = async (directory: URL, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, directory), `${prefix}/${entry.name}`);
      else if (entry.name === "route.ts") routePaths.push(prefix);
    }
  };
  await walk(root, "/api");

  const server = await readFile(new URL("../server/app.ts", import.meta.url), "utf8");
  const registered = server.slice(server.indexOf("const ROUTES"), server.indexOf("function jsonResponse"));

  const missing = routePaths.filter((route) => {
    // `[id]` yakalama grubu olarak yazılır; kalan segmentler birebir aranır.
    const pattern = route.split("/").filter(Boolean)
      .map((segment) => (segment.startsWith("[") ? "([^/]+)" : segment)).join("\\/");
    return !registered.includes(pattern);
  });
  assert.deepEqual(missing, [], `Node sunucusuna bağlanmamış rota: ${missing.join(", ")}`);
});
