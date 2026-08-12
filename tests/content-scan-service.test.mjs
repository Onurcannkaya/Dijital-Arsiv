import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("tarama servisi sabit karantina kovasını salt-okunur nesne referansıyla kullanır", async () => {
  const [main, orchestrator] = await Promise.all([
    read("services/content-scan/app/main.py"),
    read("lib/content-scan.ts"),
  ]);
  assert.match(main, /CONTENT_SCAN_QUARANTINE_BUCKET/);
  assert.match(main, /client\.get_object/);
  assert.match(main, /reference\.objectKey\.startswith\("quarantine\/"\)/);
  assert.doesNotMatch(main, /UploadFile|request\.body|put_object|delete_object/);
  assert.match(orchestrator, /objectKey: object\.object_key/);
  assert.doesNotMatch(orchestrator, /FormData|arrayBuffer/);
});

test("magic-byte, güvenli ayrıştırıcı, ClamAV ve imza yaşı birlikte fail-closed kapıdır", async () => {
  const [main, validation, docker] = await Promise.all([
    read("services/content-scan/app/main.py"),
    read("services/content-scan/app/file_validation.py"),
    read("services/content-scan/Dockerfile"),
  ]);
  assert.match(validation, /detect_media_type/);
  assert.match(validation, /qpdf.*--check/s);
  assert.match(validation, /image\.verify\(\)/);
  assert.match(main, /SIGNATURE_MAX_AGE_SECONDS = 24 \* 60 \* 60/);
  assert.match(main, /\["clamscan", "--infected", "--no-summary"/);
  assert.match(main, /scanner_result == "ERROR"/);
  assert.match(docker, /apt-get install --no-install-recommends -y clamav qpdf/);
});

test("tarama işi kiralı, yeniden denenebilir ve dead-letter görünürdür", async () => {
  const [scan, jobs, config] = await Promise.all([
    read("lib/content-scan.ts"),
    read("lib/scheduled-jobs.ts"),
    read("wrangler.jsonc"),
  ]);
  assert.match(scan, /CONTENT_SCAN_LEASE_MS/);
  assert.match(scan, /terminal \? "FAILED" : "RETRY"/);
  assert.match(scan, /max_attempts/);
  assert.match(jobs, /cron\.content-scan-result/);
  assert.match(jobs, /deadLetter/);
  assert.match(config, /CONTENT_SCAN_SERVICE_TOKEN/);
});
