const baseUrl = process.env.DEPLOY_BASE_URL?.replace(/\/$/, "");
const migrationToken = process.env.ARCHIVE_MIGRATION_TOKEN;

if (!baseUrl) {
  throw new Error("DEPLOY_BASE_URL zorunludur.");
}
if (!migrationToken || migrationToken.length < 16) {
  throw new Error("ARCHIVE_MIGRATION_TOKEN zorunludur ve en az 16 karakter olmalıdır.");
}

async function readJson(response, operation) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${operation}: JSON olmayan yanıt (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${operation}: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const headers = { authorization: `Bearer ${migrationToken}` };
const migration = await readJson(await fetch(`${baseUrl}/api/admin/migrate`, {
  method: "POST",
  headers,
  signal: AbortSignal.timeout(30_000),
}), "schema migration");

const migrationState = await readJson(await fetch(`${baseUrl}/api/admin/migrate`, {
  headers,
  signal: AbortSignal.timeout(10_000),
}), "schema version check");

if (migrationState.pending || migrationState.currentVersion !== migrationState.expectedVersion) {
  throw new Error(`Şema hazır değil: ${JSON.stringify(migrationState)}`);
}

const health = await readJson(await fetch(`${baseUrl}/api/health`, {
  signal: AbortSignal.timeout(15_000),
}), "health check");

if (health.status !== "ready") {
  throw new Error(`Dağıtım hazır değil: ${JSON.stringify(health)}`);
}

console.log(JSON.stringify({
  event: "deployment.verified",
  environment: process.env.DEPLOY_ENV ?? null,
  gitCommit: process.env.DEPLOY_GIT_COMMIT ?? null,
  baseUrl,
  migration,
  schemaVersion: migrationState.currentVersion,
  health: health.status,
  healthChecks: health.checks,
  correlationId: health.correlationId ?? null,
}));
