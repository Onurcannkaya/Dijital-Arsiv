import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Worker OCR servisine belge baytı yerine yetkili nesne referansı gönderir", async () => {
  const processor = await read("app/api/jobs/process/route.ts");
  assert.match(processor, /body:\s*JSON\.stringify\(\{[\s\S]*objectKey:\s*original\.object_key/);
  assert.match(processor, /byteSize:\s*original\.byte_size/);
  assert.match(processor, /sha256:\s*original\.sha256/);
  assert.doesNotMatch(processor, /new FormData|new File|object\.arrayBuffer|objectStorage\.get\(original\.object_key\)/);
});

test("OCR servisi sabit kovadan akışla indirir ve yetkili SHA-256 değerini doğrular", async () => {
  const service = await read("services/ocr/app/main.py");
  const requirements = await read("services/ocr/requirements.txt");
  assert.match(service, /OCR_ORIGINAL_BUCKET/);
  assert.match(service, /client\.get_object\(Bucket=bucket,\s*Key=reference\.objectKey\)/);
  assert.match(service, /body\.read\(8 \* 1024 \* 1024\)/);
  assert.match(service, /digest\.hexdigest\(\) != reference\.sha256/);
  assert.match(service, /cv2\.imread\(source_path/);
  assert.doesNotMatch(service, /UploadFile|await file\.read|File\(\.\.\.\)|Form\(/);
  assert.match(requirements, /boto3/);
  assert.doesNotMatch(requirements, /python-multipart/);
});
