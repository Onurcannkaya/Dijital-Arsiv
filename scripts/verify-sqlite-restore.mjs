#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export function verifySqliteRestore(path, expectedSchemaVersion) {
  if (!path || !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    return { ok: false, failures: ["RESTORE_FILE_INVALID"] };
  }

  const failures = [];
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      failures.push("SQLITE_INTEGRITY_FAILED");
    }
    const state = database.prepare("SELECT version FROM schema_state WHERE id = 'archive'").get();
    if (!Number.isInteger(state?.version) || Number(state.version) <= 0) {
      failures.push("SCHEMA_STATE_INVALID");
    } else if (expectedSchemaVersion !== undefined && Number(state.version) !== expectedSchemaVersion) {
      failures.push("SCHEMA_VERSION_MISMATCH");
    }
  } catch {
    failures.push("RESTORE_OPEN_FAILED");
  } finally {
    database?.close();
  }
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

function run() {
  const expected = process.env.EXPECTED_SCHEMA_VERSION?.trim();
  const expectedVersion = expected ? Number(expected) : undefined;
  const result = verifySqliteRestore(process.argv[2], expectedVersion);
  const event = result.ok ? "sqlite.restore.verified" : "sqlite.restore.invalid";
  (result.ok ? console.log : console.error)(JSON.stringify({ event, failures: result.failures }));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
