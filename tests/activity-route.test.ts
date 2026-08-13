/**
 * İşlem geçmişi rotası — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Kapsam ve maskeleme kuralları kütüphane düzeyinde kapsanıyor
 * (`activity-log`); burada ölçülen, rotanın sayfalama girdisini nasıl
 * karşıladığı. Denetim izini sayfa sayfa okuyan biri için sessizce kabul
 * edilen bozuk bir imleç, açık bir hatadan daha kötüdür: başa döner ve
 * döngüde kalıp izin tamamını gördüğünü sanır.
 *
 * Kapsanan kabuller:
 * - çözülemeyen imleç reddedilir, ilk sayfaya düşülmez;
 * - aralık dışı `limit` reddedilir, sessizce kırpılmaz;
 * - geçerli imleçle sayfalama mükerrer ya da eksik kayıt üretmez;
 * - kapsam ve maskeleme rota üzerinden de geçerlidir.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { writeAuditEvent } = await import("../lib/audit.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "denetci@sivas.bel.tr";
const CLERK = "memur@sivas.bel.tr";
const IMAR = "İmar ve Şehircilik Müdürlüğü";
const ITFAIYE = "İtfaiye Müdürlüğü";

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/gecmis",
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
          ?, 'review', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
        .bind(id, `ARS-2026-${id.toUpperCase()}`, `test/${id}`, id.padEnd(64, "d"), unit, ADMIN).run();
    }
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Memur', 'reviewer', ?, 1)`).bind(CLERK, IMAR).run();

    // Sayfalamayı ölçebilmek için birden çok olay; serbest metin de bilerek
    // konur ki maskelemenin rota üzerinden de tuttuğu görülsün.
    for (let index = 0; index < 12; index += 1) {
      await writeAuditEvent(server.db, {
        documentId: index % 2 === 0 ? "belge-imar" : "belge-itfaiye",
        actor: ADMIN,
        action: "fields.confirmed",
        details: { changes: [{ reasonNote: "gizli kalmasi gereken serbest metin" }] },
      });
    }
    await run(server);
  } finally {
    await server.close();
  }
}

type Body = { error?: string; entries?: Array<{ id: string; unit: string | null; details: Record<string, unknown> }>;
  nextCursor?: string | null; scope?: { unit: string; includesUserEvents: boolean } };

const activity = async (server: NodeServer, query = "", actor = ADMIN) => {
  const response = await fetch(`${server.url}/api/activity${query}`, {
    headers: { "oai-authenticated-user-email": actor },
  });
  return { status: response.status, body: await response.json().catch(() => null) as Body };
};

test("çözülemeyen imleç reddedilir, sessizce ilk sayfaya düşülmez", async () => {
  await withServer(async (server) => {
    const first = await activity(server, "?limit=5");
    assert.equal(first.status, 200);
    const firstIds = (first.body.entries ?? []).map((entry) => entry.id);

    // Geçerli imleç gerçekten ilerletir.
    const second = await activity(server, `?limit=5&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`);
    const secondIds = (second.body.entries ?? []).map((entry) => entry.id);
    assert.notDeepEqual(secondIds, firstIds, "geçerli imleç ilerletmedi");

    /*
     * Bozuk imleç sessizce yok sayılırsa istemci ilk sayfayı ikinci sanır ve
     * döngüye girer: denetim izini okuyan kişi baştaki kayıtları tekrar tekrar
     * görüp tamamını gördüğü sonucuna varır.
     */
    for (const bad of ["bozuk!!", "", "a".repeat(500), btoa("eksik-ayrac")]) {
      const rejected = await activity(server, `?limit=5&cursor=${encodeURIComponent(bad)}`);
      assert.equal(rejected.status, 400, `"${bad}" kabul edildi`);
      assert.match(rejected.body.error ?? "", /`cursor` değeri geçersiz/);
    }
  });
});

test("aralık dışı limit reddedilir, sessizce kırpılmaz", async () => {
  await withServer(async (server) => {
    /*
     * Basamak sayısına bakmak aralık denetimi değildir: `0` bir kayda, `999`
     * yüz kayda kırpılıyordu. İstemci istediğinden başka bir sayfa boyutu alıp
     * bunu bilmiyordu.
     */
    for (const bad of ["0", "000", "999", "-5", "2.5", "abc", " 5"]) {
      const rejected = await activity(server, `?limit=${encodeURIComponent(bad)}`);
      assert.equal(rejected.status, 400, `limit=${bad} kabul edildi`);
      assert.match(rejected.body.error ?? "", /1 ile 100 arasında/);
    }
    // Sınırlar dahildir.
    assert.equal((await activity(server, "?limit=1")).body.entries?.length, 1);
    assert.equal((await activity(server, "?limit=100")).status, 200);
  });
});

test("imleçle sayfalama mükerrer ya da eksik kayıt üretmez", async () => {
  await withServer(async (server) => {
    const all = (await activity(server, "?limit=100")).body.entries ?? [];
    const walked: string[] = [];
    let cursor: string | null | undefined = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: { status: number; body: Body } = await activity(server,
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      walked.push(...(page.body.entries ?? []).map((entry) => entry.id));
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(walked, all.map((entry) => entry.id), "sayfalanmış sıra tek seferdekinden farklı");
    assert.equal(new Set(walked).size, walked.length, "mükerrer kayıt");
  });
});

test("kapsam ve maskeleme rota üzerinden de geçerlidir", async () => {
  await withServer(async (server) => {
    const scoped = await activity(server, "?limit=100", CLERK);
    assert.deepEqual([...new Set((scoped.body.entries ?? []).map((entry) => entry.unit))], [IMAR],
      "kapsam dışı müdürlüğün kaydı sızdı");
    assert.equal(scoped.body.scope?.includesUserEvents, false, "memura yetki olayları verildi");

    /*
     * Ayrıntı alanı yalnız sabit değerli anahtarları taşır: belgenin kendi
     * izinde duran serbest metin (ret notu gibi) müdürlükler arası bu beslemeye
     * girmemelidir.
     */
    const raw = JSON.stringify((await activity(server, "?limit=100")).body.entries);
    assert.ok(!raw.includes("gizli kalmasi gereken"), "serbest metin beslemeye sızdı");
  });
});
