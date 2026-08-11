#!/usr/bin/env bash
# Kurum içi yığın uçtan uca duman testi (P7).
#
# API konteynerinin İÇİNDEN gerçek kabul akışını sürer: oturum aç → geçerli
# PDF parçasını yükle → tamamla → tarama + terfi zamanlayıcısını bekle →
# ACCEPTED (ya da tekrar koşuda DUPLICATE) terminalini doğrula; ardından
# MinIO'daki fiziksel nesneleri listeler. Vekil/SSO bu testin kapsamı
# dışındadır (bilinçli: kimlik sınırından önce çekirdek hattı kanıtlar).
#
# Kullanım (deploy/kurum-ici dizininden): ./smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE=${COMPOSE:-docker compose}

say() { printf '\n== %s ==\n' "$*"; }

say "Servis durumu"
$COMPOSE ps --format 'table {{.Name}}\t{{.Status}}'

say "Kabul akışı (api konteyneri içinden)"
$COMPOSE exec -T api node - <<'NODE'
const BASE = "http://127.0.0.1:8788";
// Kimlik: yönetici listesindeki ilk e-posta (ilk istekte bootstrap olur).
const identity = (process.env.ARCHIVE_ADMIN_EMAILS ?? "").split(",")[0]?.trim();
if (!identity) throw new Error("ARCHIVE_ADMIN_EMAILS boş; duman kimliği yok.");
const HEADERS = { "oai-authenticated-user-email": identity };

// scripts/acceptance-executors/fixtures.mjs buildPdfFixture({text:"kurum-ici-duman-testi"})
// çıktısı: qpdf'i geçen deterministik minimal PDF (602 bayt).
const PDF_BASE64 = "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MiA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcyIDcyMCBUZCAoa3VydW0taWNpLWR1bWFuLXRlc3RpKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAowMDAwMDAwMTIxIDAwMDAwIG4gCjAwMDAwMDAyNDcgMDAwMDAgbiAKMDAwMDAwMDM0OSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxOQolJUVPRgo=";
const payload = Buffer.from(PDF_BASE64, "base64");
const sha256 = require("node:crypto").createHash("sha256").update(payload).digest("hex");

const json = async (method, path, { body, headers } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...HEADERS, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const fail = (step, detail) => {
  console.error(`DUMAN TESTI BASARISIZ [${step}]:`, JSON.stringify(detail));
  process.exit(1);
};

const main = async () => {
  const health = await json("GET", "/api/health");
  console.log("saglik:", health.status, JSON.stringify(health.body?.checks ?? {}));

  const created = await json("POST", "/api/uploads", {
    headers: { "idempotency-key": `duman-${Date.now()}` },
    body: {
      unit: "Yazı İşleri Müdürlüğü",
      byteSize: payload.byteLength,
      mediaType: "application/pdf",
      originalName: "kurum-ici-duman-testi.pdf",
    },
  });
  const sessionId = created.body?.session?.id;
  if (!sessionId) fail("oturum", created);
  console.log("oturum:", sessionId);

  const part = await fetch(`${BASE}/api/uploads/${sessionId}/parts`, {
    method: "PUT",
    headers: {
      ...HEADERS,
      "x-part-number": "1",
      "x-content-sha256": sha256,
      "content-type": "application/octet-stream",
    },
    body: payload,
  });
  if (part.status !== 200) fail("parca", { status: part.status, body: await part.text() });

  const completed = await json("POST", `/api/uploads/${sessionId}/complete`, { body: {} });
  if (completed.body?.session?.status !== "QUARANTINED") fail("tamamlama", completed);
  console.log("karantina SHA:", completed.body.session.sha256, completed.body.session.sha256 === sha256 ? "(yerel ile ESIT)" : "(UYUSMAZLIK!)");
  if (completed.body.session.sha256 !== sha256) fail("sha", completed.body.session);

  // Tarama + terfi zamanlayıcısı 60 sn aralıklıdır; ilk koşuda ClamAV/OCR
  // modeli hazır olana kadar bekleyebilir.
  const deadline = Date.now() + 6 * 60_000;
  const observed = [];
  for (;;) {
    const polled = await json("GET", `/api/uploads?id=${sessionId}`);
    const status = polled.body?.session?.status ?? `HTTP_${polled.status}`;
    if (observed.at(-1) !== status) {
      observed.push(status);
      console.log("durum:", status);
    }
    if (["ACCEPTED", "DUPLICATE"].includes(status)) {
      console.log(`DUMAN TESTI BASARILI: terminal=${status} gozlenen=${observed.join(">")}`);
      if (status === "DUPLICATE") console.log("(tekrar koşu: içerik zaten arşivde — tekilleştirme çalışıyor)");
      return;
    }
    if (["REJECTED", "EXPIRED", "FAILED"].includes(status)) fail("terminal", { status, observed });
    if (Date.now() > deadline) fail("zaman-asimi", { observed, ipucu: "content-scan/ocr sağlığına ve api loglarındaki cron.* olaylarına bakın" });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
};
main().catch((error) => fail("beklenmeyen", { message: error?.message }));
NODE

say "MinIO fiziksel envanteri"
$COMPOSE exec -T minio sh -c '
  mc alias set yerel http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  echo "-- arsiv-asil (asil kasa):";      mc ls --recursive yerel/arsiv-asil | tail -5
  echo "-- arsiv-karantina:";             mc ls --recursive yerel/arsiv-karantina | tail -5
  echo "-- arsiv-gecici (bos olmali):";   mc ls --recursive yerel/arsiv-gecici | tail -5 || true
'

say "Duman testi tamamlandı"
