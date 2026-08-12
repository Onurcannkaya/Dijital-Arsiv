import { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite` üzerine kurulu asgari D1 taklidi.
 *
 * Şema ve göç mantığını gerçekten çalıştırmak için gerekli: dize araması yapan
 * bir test, `CREATE TABLE`'a eklenip göç adımı yazılmayan bir kolonu yakalamaz —
 * bu tam olarak sürüm 3'te üretimde ortaya çıkan hataydı. Bu taklit yalnız
 * `lib/archive-schema.ts` dosyasının kullandığı yüzeyi kapsar.
 */
export type FakeD1 = D1Database & { close(): void; raw: DatabaseSync };

export function createSqliteD1(location = ":memory:"): FakeD1 {
  const database = new DatabaseSync(location);
  database.exec("PRAGMA foreign_keys = ON");

  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        args = values.map((value) => (typeof value === "boolean" ? Number(value) : value));
        return statement;
      },
      async first<T>() {
        const row = database.prepare(sql).get(...(args as never[]));
        return (row ?? null) as T | null;
      },
      async all<T>() {
        return { results: database.prepare(sql).all(...(args as never[])) as T[], success: true };
      },
      async run() {
        const result = database.prepare(sql).run(...(args as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      /** D1 `batch()` içinde çalıştırılabilmesi için ham SQL ve argümanlar. */
      __execute() {
        const result = database.prepare(sql).run(...(args as never[]));
        return Number(result.changes);
      },
    };
    return statement;
  };

  const db = {
    prepare,
    /** D1 `batch()` tek işlemdir: bir ifade başarısız olursa tümü geri alınır. */
    async batch(statements: Array<{ __execute(): number }>) {
      database.exec("BEGIN");
      const changes: number[] = [];
      try {
        for (const statement of statements) changes.push(statement.__execute());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return changes.map((count) => ({ success: true, meta: { changes: count } }));
    },
    close() {
      database.close();
    },
    raw: database,
  };
  return db as unknown as FakeD1;
}

/** Tablodaki kolon adları. */
export function columnsOf(db: FakeD1, table: string): string[] {
  return (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

/** Veritabanındaki tablo adları (SQLite iç tabloları hariç). */
export function tablesOf(db: FakeD1): string[] {
  return (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

export function indexesOf(db: FakeD1): string[] {
  return (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

/** Bir yazma denemesinin kısıt tarafından reddedildiğini doğrular. */
export function rejects(db: FakeD1, sql: string, ...args: unknown[]): boolean {
  try {
    db.raw.prepare(sql).run(...(args as never[]));
    return false;
  } catch {
    return true;
  }
}
