/**
 * Kurum içi port P2 — `node:sqlite` üzerinde üretim sınıfı D1 sarmalayıcısı.
 *
 * D1 zaten SQLite olduğundan şema, göçler ve değişmezlik tetikleyicileri
 * birebir çalışır; bu modül kod tabanının kullandığı D1 yüzeyini
 * (`prepare().bind().first/all/run` + işlemsel `batch`) kurum içi Node
 * çalışma zamanında karşılar. `tests/sqlite-d1.ts` test şiminden farkları:
 *
 * - Kalıcılık: WAL + `synchronous=FULL`. Denetim zinciri olayları onaylanmış
 *   bir yazmadan sonra elektrik kesintisinde bile kaybolmamalıdır; yazma
 *   hacmi düşük olduğundan commit başına fsync maliyeti kabul edilebilir.
 * - `busy_timeout`: yedek/bakım süreçleri kısa kilitlerde hata değil bekleme
 *   üretir.
 * - `batch()` D1 sözleşmesindeki gibi TEK işlemdir ve `BEGIN IMMEDIATE` ile
 *   yazma kilidini baştan alır; ara durumdaki busy sürprizleri elenir.
 * - Hazır ifadeler SQL metnine göre önbellenir (sorgu kümesi statiktir).
 * - `undefined` bağlama değeri sessiz NULL yerine açık hatadır (D1 davranışı).
 *
 * Bu dosya Workers paketine girmez: yalnız Node önyüklemesi (P4) içe aktarır
 * ve `createNodeEnvBindingsProvider`'a `db` adaptörü olarak verir.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type NodeSqliteD1 = D1Database & {
  /** WAL'i ana dosyaya indirger ve bağlantıyı kapatır (temiz yedek noktası). */
  close(): void;
  /** Yedek almadan önce WAL'i ana dosyaya indirger. */
  checkpoint(): void;
  readonly location: string;
};

export type NodeSqliteD1Options = {
  /** Veritabanı dosya yolu; testler için ":memory:" kabul edilir. */
  path: string;
  /** Kilit beklemesi (ms). Varsayılan 5000. */
  busyTimeoutMs?: number;
};

type BoundValue = null | number | bigint | string | Uint8Array;

function normalizeBinding(value: unknown, index: number): BoundValue {
  if (value === undefined) {
    throw new TypeError(`D1 bağlama değeri tanımsız olamaz (parametre ${index + 1}).`);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || typeof value === "number" || typeof value === "bigint"
    || typeof value === "string" || value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`Desteklenmeyen D1 bağlama türü (parametre ${index + 1}): ${typeof value}`);
}

export function createNodeSqliteD1(options: NodeSqliteD1Options): NodeSqliteD1 {
  const location = options.path;
  if (location !== ":memory:") mkdirSync(dirname(location), { recursive: true });
  const database = new DatabaseSync(location);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`);
  if (location !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
  }

  const cache = new Map<string, StatementSync>();
  const compiled = (sql: string) => {
    const existing = cache.get(sql);
    if (existing) return existing;
    const statement = database.prepare(sql);
    cache.set(sql, statement);
    return statement;
  };

  function prepare(sql: string) {
    let args: BoundValue[] = [];
    const statement = {
      bind(...values: unknown[]) {
        args = values.map(normalizeBinding);
        return statement;
      },
      async first<T>() {
        const row = compiled(sql).get(...(args as never[]));
        return (row ?? null) as T | null;
      },
      async all<T>() {
        const results = compiled(sql).all(...(args as never[])) as T[];
        return { results, success: true as const, meta: { changes: 0 } };
      },
      async run() {
        const result = compiled(sql).run(...(args as never[]));
        return { success: true as const, meta: { changes: Number(result.changes) } };
      },
      /** `batch()` işlemi içinde eşzamansızlık olmadan çalıştırma noktası. */
      __execute() {
        const result = compiled(sql).run(...(args as never[]));
        return Number(result.changes);
      },
    };
    return statement;
  }

  const db = {
    prepare,
    /** D1 sözleşmesi: tek işlem; herhangi bir ifade başarısız olursa tümü geri alınır. */
    async batch(statements: Array<{ __execute(): number }>) {
      database.exec("BEGIN IMMEDIATE");
      const changes: number[] = [];
      try {
        for (const statement of statements) changes.push(statement.__execute());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return changes.map((count) => ({ success: true as const, meta: { changes: count } }));
    },
    checkpoint() {
      if (location !== ":memory:") database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    close() {
      try {
        db.checkpoint();
      } finally {
        cache.clear();
        database.close();
      }
    },
    location,
  };
  return db as unknown as NodeSqliteD1;
}
