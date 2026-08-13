/**
 * Belge erişim rotası — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Bu rota, belge baytlarının arşivden çıktığı tek yoldur. Bilet mekaniği
 * kütüphane düzeyinde kapsanıyor (`access-tickets`), ama kimliğin başlıktan
 * okunması, URL'ye gömülü kimliğin reddi ve kapsamın sunulan nesne sınıfıyla
 * eşleştirilmesi rotada olur ve bugüne dek yalnız KAYNAK METİN taramasıyla
 * denetleniyordu: `assert.match(fileRoute, /URL_CREDENTIAL_REJECTED/)` dizenin
 * kaynakta geçtiğini söyler, denetimin çalıştığını değil.
 *
 * Baytların başarıyla sunulması kabul koşusunun kapsamındadır (T-05); burada
 * ölçülen, sunulmaması gereken her durumun gerçekten durdurulduğudur.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "arsiv@sivas.bel.tr";
const VIEWER = "gorus@sivas.bel.tr";
const OUTSIDER = "baska@sivas.bel.tr";
const IMAR = "İmar ve Şehircilik Müdürlüğü";
const ITFAIYE = "İtfaiye Müdürlüğü";
const JSON_ADMIN = { "oai-authenticated-user-email": ADMIN, "content-type": "application/json" };

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/erisim",
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    for (const [id, unit] of [["belge-imar", IMAR], ["belge-itfaiye", ITFAIYE]] as const) {
      await server.db.prepare(`INSERT INTO archive_documents
          (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
           document_type, unit, status, uploaded_by, created_at, updated_at)
        VALUES (?, ?, 'tutanak.pdf', ?, 'application/pdf', 2048, ?, 'Numarataj tespit tutanağı',
          ?, 'archived', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
        .bind(id, `ARS-2026-${id.toUpperCase()}`, `test/${id}`, id.padEnd(64, "f"), unit, ADMIN).run();
      // Asıl nesne kaydı: bilet asıla bağlanır, kasada bayt olması gerekmez.
      await server.db.prepare(`INSERT INTO binary_objects
          (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator)
        VALUES (?, ?, 'original', ?, 'application/pdf', 2048, ?, 'test')`)
        .bind(`obj-${id}`, id, `originals/${id}/1`, id.padEnd(64, "f")).run();
    }
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Görüntüleyici', 'viewer', '*', 1)`).bind(VIEWER).run();
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Başka Birim', 'archive_manager', ?, 1)`).bind(OUTSIDER, ITFAIYE).run();
    await run(server);
  } finally {
    await server.close();
  }
}

type Json = { error?: string; code?: string; ticket?: string };

const issue = async (server: NodeServer, documentId: string,
  scope: "VIEW" | "DOWNLOAD", actor = ADMIN) => {
  const response = await fetch(`${server.url}/api/documents/${documentId}/access-ticket`, {
    method: "POST",
    headers: { ...JSON_ADMIN, "oai-authenticated-user-email": actor },
    body: JSON.stringify({ scope, purpose: scope === "VIEW" ? "DOCUMENT_REVIEW" : "ORIGINAL_DOWNLOAD" }),
  });
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};

/**
 * Bilet oturumun YERİNE geçmez, üzerine biner: istek hem kimlik doğrulanmış
 * kullanıcıyı hem bileti taşımalıdır. Bu yüzden yardımcı kimliği her zaman
 * ekler; biletsizlik ayrı ayrı sınanır.
 */
const fetchFile = async (server: NodeServer, documentId: string,
  init: RequestInit = {}, actor = ADMIN) => {
  const response = await fetch(`${server.url}/api/documents/${documentId}/file`, {
    ...init,
    headers: { ...(init.headers ?? {}), "oai-authenticated-user-email": actor },
  });
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};

const deniedReasons = async (server: NodeServer, documentId: string) => {
  const rows = await server.db.prepare(`SELECT action, details_json FROM audit_events
    WHERE document_id = ? ORDER BY event_number`).bind(documentId)
    .all<{ action: string; details_json: string }>();
  return (rows.results ?? [])
    .filter((row) => row.action === "document.access-denied")
    .map((row) => (JSON.parse(row.details_json) as { reason?: string }).reason);
};

test("kimliksiz istek ve URL'ye gömülü kimlik reddedilir", async () => {
  await withServer(async (server) => {
    // Kimliği doğrulanmış ama biletsiz istek: 403.
    const noTicket = await fetchFile(server, "belge-imar");
    assert.equal(noTicket.status, 403);

    /*
     * Geçerli bilet, oturumun yerini almaz. Yalnız bilet taşıyan istek kimlik
     * katmanında durur; aksi halde sızan bir bilet, kimliği olmayan birine
     * belge açardı.
     */
    const ticketOnly = await issue(server, "belge-imar", "DOWNLOAD");
    const anonymous = await fetch(`${server.url}/api/documents/belge-imar/file`, {
      headers: { authorization: `ArchiveTicket ${ticketOnly.body.ticket}`, "x-archive-access-scope": "DOWNLOAD" },
    });
    assert.equal(anonymous.status, 401);

    /*
     * Bilet URL'ye yazılırsa sunucu günlüğüne, tarayıcı geçmişine ve
     * yönlendiren başlığına düşer; oradan kopyalayan herkes belgeyi indirir.
     * Bu yüzden URL'de kimlik taşıyan istek, bilet GEÇERLİ olsa bile
     * reddedilir.
     */
    const valid = await issue(server, "belge-imar", "DOWNLOAD");
    const inUrl = await fetch(`${server.url}/api/documents/belge-imar/file?ticket=${valid.body.ticket}`,
      { headers: { "oai-authenticated-user-email": ADMIN } });
    assert.equal(inUrl.status, 403);

    /*
     * Ret gerekçesi istemciye açılmaz, denetime yazılır: saldırgana biletin
     * hangi denetimde durduğunu öğretmemek için cevaplar tek tiptir, ama
     * işletim geçmişe bakıp neyin reddedildiğini görebilmelidir.
     */
    assert.deepEqual(await deniedReasons(server, "belge-imar"),
      ["CREDENTIAL_REQUIRED", "URL_CREDENTIAL_REJECTED"], "ret gerekçeleri denetime yazılmadı");
  });
});

test("bilet tek kullanımlıktır ve başka belgede kullanılamaz", async () => {
  await withServer(async (server) => {
    const first = await issue(server, "belge-imar", "DOWNLOAD");
    const headers = { authorization: `ArchiveTicket ${first.body.ticket}`, "x-archive-access-scope": "DOWNLOAD" };

    // İlk kullanım bileti tüketir; kasada bayt olmadığı için 404 döner.
    const used = await fetchFile(server, "belge-imar", { headers });
    assert.equal(used.status, 404);
    assert.match(used.body.error ?? "", /kasada bulunamadı/);

    // Tüketilen bilet ikinci kez çalışmaz: yakalanan bir bilet tekrar oynatılamaz.
    assert.equal((await fetchFile(server, "belge-imar", { headers })).status, 403);

    /*
     * Bilet belgeye bağlıdır. Bir belge için alınan bilet başka bir belgenin
     * baytlarını açamamalıdır; aksi halde tek bir yetkili istek bütün arşive
     * anahtar olurdu.
     */
    const other = await issue(server, "belge-imar", "DOWNLOAD");
    const crossed = await fetchFile(server, "belge-itfaiye", {
      headers: { authorization: `ArchiveTicket ${other.body.ticket}`, "x-archive-access-scope": "DOWNLOAD" },
    });
    assert.equal(crossed.status, 403);
  });
});

test("kapsam biletle ve sunulan nesne sınıfıyla eşleşmelidir", async () => {
  await withServer(async (server) => {
    // Amaç kodu kapalıdır: kapsamla uyuşmayan amaç bilet üretmez.
    const mismatch = await fetch(`${server.url}/api/documents/belge-imar/access-ticket`, {
      method: "POST", headers: JSON_ADMIN,
      body: JSON.stringify({ scope: "VIEW", purpose: "ORIGINAL_DOWNLOAD" }),
    });
    assert.equal(mismatch.status, 400);

    // VIEW bileti türeve bağlanır; türev yoksa bilet hiç verilmez.
    const view = await issue(server, "belge-imar", "VIEW");
    assert.equal(view.status, 425);
    assert.match(view.body.error ?? "", /görüntüleme kopyası henüz hazırlanıyor/);

    // DOWNLOAD bileti indirme kapsamı dışında sunulamaz.
    const download = await issue(server, "belge-imar", "DOWNLOAD");
    const wrongScope = await fetchFile(server, "belge-imar", {
      headers: { authorization: `ArchiveTicket ${download.body.ticket}`, "x-archive-access-scope": "VIEW" },
    });
    assert.equal(wrongScope.status, 403);
  });
});

test("rol ve müdürlük kapsamı bilet verilişinde uygulanır", async () => {
  await withServer(async (server) => {
    /*
     * Asıl belgeyi indirmek ayrı bir yetkidir: görüntüleyici belgeyi
     * inceleyebilir ama asıl dosyayı alamaz.
     */
    const viewerDownload = await issue(server, "belge-imar", "DOWNLOAD", VIEWER);
    assert.equal(viewerDownload.status, 403);
    assert.match(viewerDownload.body.error ?? "", /rolünüz için yetkili değildir/);
    // Aynı kullanıcı görüntüleme isteyebilir; engel yalnız türevin yokluğudur.
    assert.equal((await issue(server, "belge-imar", "VIEW", VIEWER)).status, 425);

    // Kapsam dışı müdürlük bilet alamaz; ret dosya ucuna kadar ilerlemez.
    const outside = await issue(server, "belge-imar", "DOWNLOAD", OUTSIDER);
    assert.equal(outside.status, 403);
    assert.match(outside.body.error ?? "", /müdürlük kapsamınızın dışında/);
    // Kendi müdürlüğünde bilet alabilir.
    assert.equal((await issue(server, "belge-itfaiye", "DOWNLOAD", OUTSIDER)).status, 201);
  });
});

test("biçimsiz kimlik bilgisi tek tip reddedilir ve özetlenmez", async () => {
  await withServer(async (server) => {
    // Ayrı ayrı mesaj vermek, saldırgana biletin hangi aşamada bozulduğunu
    // öğretir; hepsi aynı cevabı almalıdır.
    const malformed = ["ArchiveTicket", "ArchiveTicket kisa", "Bearer bir-sey", "ArchiveTicket " + "x".repeat(400)];
    const answers = new Set<string>();
    for (const value of malformed) {
      const refused = await fetchFile(server, "belge-imar", {
        headers: { authorization: value, "x-archive-access-scope": "DOWNLOAD" },
      });
      assert.equal(refused.status, 403, value);
      answers.add(refused.body.error ?? "");
    }
    assert.equal(answers.size, 1, "biçimsiz kimlikler farklı cevaplar aldı");

    // Denetim kaydı serbest metin taşımaz: yalnız kapalı gerekçe kodu.
    const reasons = await deniedReasons(server, "belge-imar");
    assert.ok(reasons.length >= malformed.length);
    assert.ok(reasons.every((reason) => typeof reason === "string" && /^[A-Z_]+$/.test(reason)),
      `denetim kaydında kapalı kod olmayan gerekçe var: ${reasons.join(", ")}`);
  });
});
