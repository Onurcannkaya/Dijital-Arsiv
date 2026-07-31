/**
 * F1.11 — Kabul koşusu kanıt sözleşmesinin saf çekirdeği.
 *
 * FAZ_1_KANIT_REHBERI.md sözleşmesini koda döker: test kataloğu (12 politika +
 * 7 kabul hattı testi), sonuç değerleri, kapı kuralları ve maskeli kanıt
 * manifesti. Bu modül ağ/dosya erişimi yapmaz; koşu betiği ve birim testleri
 * aynı kuralları paylaşır.
 */

import { createHash } from "node:crypto";

export const RESULTS = Object.freeze(["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"]);

/** Kanıt rehberi §5–§6: kimlikler, yürüten/onaylayan ve otomasyon ön koşulları. */
export const TEST_CATALOG = Object.freeze([
  { id: "T-01", title: "Aynı anahtara ikinci yazma engellenir", executor: "Yazılım Geliştirme", approver: "Bilgi Güvenliği", requires: ["s3"] },
  { id: "T-02", title: "Asıl SHA yazma sonrası doğrulanır", executor: "Yazılım Geliştirme", approver: "Bilgi Güvenliği + Arşiv", requires: ["staging"] },
  { id: "T-03", title: "Asıl değişmeden türev üretilir", executor: "Yazılım Geliştirme", approver: "Arşiv + Bilgi Güvenliği", requires: ["staging"] },
  { id: "T-04", title: "Kullanıcı bucket anahtarı alamaz", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"] },
  { id: "T-05", title: "Süresi dolan görüntüleme bileti çalışmaz", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"] },
  { id: "T-06", title: "Yetkisiz rol aslı okuyamaz veya silemez", executor: "Bilgi Güvenliği", approver: "Bilgi İşlem yöneticisi", requires: ["iamIdentities"] },
  { id: "T-07", title: "Sürümleme/Object Lock ve yasal bekletme", executor: "Depolama İşletimi + Bilgi Güvenliği", approver: "Arşiv + Hukuk/KVKK + Bilgi İşlem", requires: ["providerLockProfile"] },
  { id: "T-08", title: "Bütünlük taraması uyuşmazlığı yakalar", executor: "Kalite Güvence", approver: "Bilgi Güvenliği + Depolama İşletimi", requires: ["staging", "s3"] },
  { id: "T-09", title: "Belge bağlamıyla yedekten geri yüklenir", executor: "Yedekleme/Depolama İşletimi", approver: "Arşiv + Bilgi İşlem yöneticisi", requires: ["restoreDrill"] },
  { id: "T-10", title: "Sağlayıcı taşınabilirlik manifesti doğrulanır", executor: "Depolama İşletimi", approver: "Bilgi Güvenliği + Arşiv", requires: ["secondProvider"] },
  { id: "T-11", title: "Anahtar ve erişim logunda kişisel veri yoktur", executor: "Kalite Güvence + Veri Koruma", approver: "Hukuk/KVKK + Bilgi Güvenliği", requires: ["staging", "logAccess"] },
  { id: "T-12", title: "İki yönlü uzlaştırma rapor üretir", executor: "Kalite Güvence", approver: "Depolama İşletimi + Arşiv", requires: ["staging", "s3"] },
  { id: "K-1", title: "MIME/magic-byte uyuşmazlığı reddedilir", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"] },
  { id: "K-2", title: "EICAR karantinada reddedilir", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"] },
  { id: "K-3", title: "Multipart kesinti sonrası sürer", executor: "Kalite Güvence", approver: "Yazılım Geliştirme", requires: ["staging"] },
  { id: "K-4", title: "Karantina normal rolle okunamaz", executor: "Bilgi Güvenliği", approver: "Bilgi İşlem yöneticisi", requires: ["iamIdentities"] },
  { id: "K-5", title: "Terfi sonrası DB hatası aslı silmez", executor: "Kalite Güvence", approver: "Arşiv", requires: ["faultInjection"] },
  { id: "K-6", title: "Azami profil eşzamanlı yükleme bellek disiplini", executor: "Performans/Kalite Güvence", approver: "Bilgi İşlem", requires: ["staging", "largeFixtures"] },
  { id: "K-7", title: "Mükerrer SHA yeni belge/asıl/OCR üretmez", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"] },
]);

/** Ortam değişkenlerinden hangi kabul yeteneklerinin hazır olduğunu çözer. */
export function resolveCapabilities(env) {
  const has = (name) => typeof env[name] === "string" && env[name].trim().length > 0;
  const staging = has("ACCEPTANCE_BASE_URL") && has("ARCHIVE_MIGRATION_TOKEN");
  const s3 = has("ACCEPTANCE_S3_ENDPOINT") && has("ACCEPTANCE_ORIGINAL_BUCKET");
  return {
    staging,
    s3,
    iamIdentities: staging && has("ACCEPTANCE_VIEWER_IDENTITY") && has("ACCEPTANCE_UNAUTHORIZED_IDENTITY"),
    providerLockProfile: s3 && has("ACCEPTANCE_LOCK_PROFILE"),
    restoreDrill: s3 && has("ACCEPTANCE_RESTORE_BUCKET"),
    secondProvider: has("ACCEPTANCE_SECOND_S3_ENDPOINT") && has("ACCEPTANCE_SECOND_BUCKET"),
    logAccess: staging && has("ACCEPTANCE_LOG_ENDPOINT"),
    faultInjection: staging && env.ACCEPTANCE_FAULT_INJECTION === "enabled",
    largeFixtures: env.ACCEPTANCE_LARGE_FIXTURES === "enabled",
  };
}

/** Bir testin çalıştırılabilmesi için gereken bütün yetenekler hazır mı? */
export function missingCapabilities(test, capabilities) {
  return (test.requires ?? []).filter((requirement) => !capabilities[requirement]);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Kanıt rehberi §2/§8 kapı kuralı: 19 testin TAMAMI sonuçlandırılmalı;
 * uygulanabilir olanların hepsi PASS, `NOT_APPLICABLE` yalnız yetkili ADR
 * referansıyla ve yalnız T-07 için; FAIL veya BLOCKED kapıyı kapatır.
 * `SKIPPED`/boş sonuç sözleşmede yoktur ve geçersizdir.
 */
export function evaluateGate(results) {
  const failures = [];
  const byId = new Map(results.map((result) => [result.id, result]));
  if (results.length !== byId.size) failures.push("DUPLICATE_RESULT");
  for (const test of TEST_CATALOG) {
    const result = byId.get(test.id);
    if (!result) {
      failures.push(`MISSING:${test.id}`);
      continue;
    }
    if (!RESULTS.includes(result.result)) {
      failures.push(`INVALID_RESULT:${test.id}`);
      continue;
    }
    if (result.result === "NOT_APPLICABLE") {
      if (test.id !== "T-07" || !/^ADR-\d{3}$/.test(String(result.adrReference ?? ""))) {
        failures.push(`NOT_APPLICABLE_UNAUTHORIZED:${test.id}`);
      }
      continue;
    }
    if (result.result !== "PASS") failures.push(`${result.result}:${test.id}`);
  }
  for (const result of results) {
    if (!TEST_CATALOG.some((test) => test.id === result.id)) {
      failures.push(`UNKNOWN_TEST:${result.id}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

const SECRET_ENV_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;

/**
 * Bağlam maskeleme: kanıta hangi ön koşulların sağlandığı yazılır, değerler
 * asla yazılmaz. Sır benzeri adlar için varlık bilgisi bile ada indirgenir.
 */
export function maskContext(context) {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => {
    if (typeof value === "boolean") return [key, value];
    if (value === null || value === undefined || value === "") return [key, false];
    if (SECRET_ENV_PATTERN.test(key)) return [key, true];
    if (key === "baseUrl") return [key, maskUrl(String(value))];
    return [key, true];
  }));
}

function maskUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return true;
  }
}

/**
 * Değişmez kanıt manifesti (kanıt rehberi §3): koşu kimliği, commit, ortam,
 * zamanlar, test sonuçları ve kanıt dosyalarının SHA-256 değerleri. Manifest
 * kanonik JSON'dur; özeti paket DIŞINDAKİ yedek kataloğuna kaydedilir.
 */
export function buildEvidenceManifest(input) {
  const manifest = {
    runId: input.runId,
    gitCommit: input.gitCommit,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    environment: input.environment,
    adapterProfile: input.adapterProfile,
    initiatedBy: input.initiatedBy,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    context: maskContext(input.context),
    results: [...input.results]
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map((result) => ({
        id: result.id,
        title: TEST_CATALOG.find((test) => test.id === result.id)?.title ?? null,
        result: result.result,
        durationMs: result.durationMs ?? null,
        correlationId: result.correlationId ?? null,
        errorCode: result.errorCode ?? null,
        adrReference: result.adrReference ?? null,
        blockedOn: result.blockedOn ?? null,
        executor: TEST_CATALOG.find((test) => test.id === result.id)?.executor ?? null,
        approver: TEST_CATALOG.find((test) => test.id === result.id)?.approver ?? null,
      })),
    evidenceFiles: [...input.evidenceFiles]
      .sort((left, right) => (left.file < right.file ? -1 : 1)),
    gate: evaluateGate(input.results),
  };
  return { manifest, digest: sha256Hex(canonicalJson(manifest)) };
}
