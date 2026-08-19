/**
 * Kurum içi port P4 — Node API sunucusu.
 *
 * app/api altındaki rota modülleri standart Request/Response sözleşmesiyle
 * yazıldığından burada değiştirilmeden kullanılır: bu dosya yalnız yol
 * eşlemesi, Node HTTP köprüsü ve cron yerine geçen iş zamanlayıcısını içerir.
 * UI sayfaları bu sunucunun kapsamı dışındadır (ters vekil ayrı sunar);
 * /api dışındaki yollar 404 döner.
 *
 * Kimlik sözleşmesi: uygulama `oai-authenticated-user-email` başlıklarına
 * güvenir. Bu sunucu YALNIZ bu başlıkları enjekte eden ters vekilin arkasında
 * çalıştırılmalıdır (vars. 127.0.0.1'e bağlanır); doğrudan ağ erişimi P5
 * kimlik katmanı olmadan açılmamalıdır.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { getArchiveBindings } from "../lib/archive-storage.ts";
import { bootstrapNodeRuntime, type NodeRuntimeOptions } from "../lib/node-runtime.ts";
import type { NodeSqliteD1 } from "../lib/node-sqlite-d1.ts";
import { logEvent } from "../lib/observability.ts";
import {
  CONTENT_SCAN_CRON, INTEGRITY_CRON, MAINTENANCE_CRON, OCR_CRON, runScheduledJob,
} from "../lib/scheduled-jobs.ts";

import * as health from "../app/api/health/route.ts";
import * as me from "../app/api/me/route.ts";
import * as overview from "../app/api/overview/route.ts";
import * as profiles from "../app/api/profiles/route.ts";
import * as documents from "../app/api/documents/route.ts";
import * as documentDetail from "../app/api/documents/[id]/route.ts";
import * as documentApprove from "../app/api/documents/[id]/approve/route.ts";
import * as documentFields from "../app/api/documents/[id]/fields/route.ts";
import * as documentText from "../app/api/documents/[id]/text/route.ts";
import * as documentRelations from "../app/api/documents/[id]/relations/route.ts";
import * as documentAccessTicket from "../app/api/documents/[id]/access-ticket/route.ts";
import * as documentFile from "../app/api/documents/[id]/file/route.ts";
import * as uploads from "../app/api/uploads/route.ts";
import * as uploadParts from "../app/api/uploads/[id]/parts/route.ts";
import * as uploadComplete from "../app/api/uploads/[id]/complete/route.ts";
import * as uploadRetry from "../app/api/uploads/[id]/retry/route.ts";
import * as jobsProcess from "../app/api/jobs/process/route.ts";
import * as pipelineAdvance from "../app/api/pipeline/advance/route.ts";
import * as adminMaintenance from "../app/api/admin/maintenance/route.ts";
import * as adminMigrate from "../app/api/admin/migrate/route.ts";
import * as adminScan from "../app/api/admin/scan/route.ts";
import * as acceptanceEvidence from "../app/api/admin/acceptance-evidence/[id]/route.ts";
import * as activity from "../app/api/activity/route.ts";
import * as internalObjects from "../app/api/internal/objects/route.ts";
import * as settings from "../app/api/settings/route.ts";
import * as users from "../app/api/users/route.ts";

type RouteModule = Record<string, unknown>;
type RouteHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Yol düzeni app/api dizin yapısını birebir izler; tek yakalama grubu `id` parametresidir. */
const ROUTES: Array<{ pattern: RegExp; module: RouteModule }> = [
  { pattern: /^\/api\/health$/, module: health },
  { pattern: /^\/api\/me$/, module: me },
  { pattern: /^\/api\/overview$/, module: overview },
  { pattern: /^\/api\/profiles$/, module: profiles },
  { pattern: /^\/api\/activity$/, module: activity },
  // Yalnız yerel geliştirmede açılır (ARCHIVE_INTERNAL_OBJECT_FETCH); rota
  // kayıtlı kalır ki uç, bayrak kapalıyken de tek tip 404 versin.
  { pattern: /^\/api\/internal\/objects$/, module: internalObjects },
  { pattern: /^\/api\/settings$/, module: settings },
  { pattern: /^\/api\/users$/, module: users },
  { pattern: /^\/api\/documents$/, module: documents },
  { pattern: /^\/api\/documents\/([^/]+)$/, module: documentDetail },
  { pattern: /^\/api\/documents\/([^/]+)\/approve$/, module: documentApprove },
  { pattern: /^\/api\/documents\/([^/]+)\/fields$/, module: documentFields },
  { pattern: /^\/api\/documents\/([^/]+)\/text$/, module: documentText },
  { pattern: /^\/api\/documents\/([^/]+)\/relations$/, module: documentRelations },
  { pattern: /^\/api\/documents\/([^/]+)\/access-ticket$/, module: documentAccessTicket },
  { pattern: /^\/api\/documents\/([^/]+)\/file$/, module: documentFile },
  { pattern: /^\/api\/uploads$/, module: uploads },
  { pattern: /^\/api\/uploads\/([^/]+)\/parts$/, module: uploadParts },
  { pattern: /^\/api\/uploads\/([^/]+)\/complete$/, module: uploadComplete },
  { pattern: /^\/api\/uploads\/([^/]+)\/retry$/, module: uploadRetry },
  { pattern: /^\/api\/jobs\/process$/, module: jobsProcess },
  { pattern: /^\/api\/pipeline\/advance$/, module: pipelineAdvance },
  { pattern: /^\/api\/admin\/maintenance$/, module: adminMaintenance },
  { pattern: /^\/api\/admin\/migrate$/, module: adminMigrate },
  { pattern: /^\/api\/admin\/scan$/, module: adminScan },
  { pattern: /^\/api\/admin\/acceptance-evidence\/([^/]+)$/, module: acceptanceEvidence },
];

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export async function handleApiRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const handler = route.module[request.method === "HEAD" ? "GET" : request.method];
    if (typeof handler !== "function") {
      return jsonResponse(405, { error: "Yöntem bu uç için tanımlı değil." });
    }
    const params: Record<string, string> = match[1] !== undefined
      ? { id: decodeURIComponent(match[1]) } : {};
    try {
      return await (handler as RouteHandler)(request, { params: Promise.resolve(params) });
    } catch (error) {
      logEvent("error", "node.route-failed", {
        path: pathname,
        method: request.method,
        message: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(500, { error: "İstek işlenemedi." });
    }
  }
  return jsonResponse(404, { error: "Uç bulunamadı; bu sunucu yalnız /api yollarını sunar." });
}

function toWebRequest(req: IncomingMessage, canonicalHost: string): Request {
  // Kimlik katmanındaki localhost yerel-pilot dolgusu (lib/authorization.ts)
  // kurum içi sunucuda ASLA tetiklenmemelidir: istek URL'si her zaman kanonik
  // ana bilgisayar adıyla kurulur. Pilot dolgusunu bilerek isteyen operatör
  // ARCHIVE_CANONICAL_HOST=127.0.0.1 vererek açabilir.
  const url = `http://${canonicalHost}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = req.method ?? "GET";
  const body = ["GET", "HEAD"].includes(method)
    ? undefined
    : Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  // 2 GiB'a kadar yükleme gövdeleri uçtan uca akar; tamponlanmaz.
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
}

async function writeNodeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const readable = Readable.fromWeb(response.body as never);
    readable.once("error", reject);
    res.once("close", resolve);
    res.once("error", reject);
    readable.pipe(res);
  });
}

/** Wrangler cron tetikleyicilerinin Node karşılığı: sabit aralıklı, üst üste binmeyen koşular. */
const CRON_INTERVALS: Array<[cron: string, intervalMs: number]> = [
  [CONTENT_SCAN_CRON, 60_000],
  [OCR_CRON, 2 * 60_000],
  [MAINTENANCE_CRON, 5 * 60_000],
  [INTEGRITY_CRON, 6 * 60 * 60_000],
];

export function startScheduler(intervals: Array<[string, number]> = CRON_INTERVALS): () => void {
  const timers = intervals.map(([cron, intervalMs]) => {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await runScheduledJob(getArchiveBindings(), cron);
      } catch (error) {
        logEvent("error", "node.scheduled-job-failed", {
          cron,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        busy = false;
      }
    }, intervalMs);
    timer.unref();
    return timer;
  });
  return () => timers.forEach((timer) => clearInterval(timer));
}

export type NodeServerOptions = {
  runtime?: NodeRuntimeOptions;
  host?: string;
  port?: number;
  /** Vars. true: açılışta şema göçleri uygulanır. */
  migrate?: boolean;
  /** Vars. true: cron eşdeğeri iş zamanlayıcısı başlar. */
  scheduler?: boolean;
};

export type NodeServer = {
  url: string;
  server: Server;
  /**
   * Çalışan sunucunun veritabanı tutamacı.
   *
   * Testler arşiv kaydını doğrudan kurabilsin diye açılır: arama ve süzme
   * davranışı, kabul hattının tamamını (tarama, terfi, OCR servisleri)
   * koşturmadan gerçek rota üzerinden ölçülebilmelidir.
   */
  db: NodeSqliteD1;
  close(): Promise<void>;
};

export async function startNodeServer(options: NodeServerOptions = {}): Promise<NodeServer> {
  const env = options.runtime?.env ?? process.env;
  const runtime = bootstrapNodeRuntime(options.runtime);
  try {
    if (options.migrate ?? true) await applyArchiveMigrations(runtime.db);
  } catch (error) {
    runtime.close();
    throw error;
  }

  const canonicalHost = env.ARCHIVE_CANONICAL_HOST?.trim() || "arsiv.kurum-ici.internal";
  const server = createServer((req, res) => {
    handleApiRequest(toWebRequest(req, canonicalHost))
      .then((response) => writeNodeResponse(response, res))
      .catch((error) => {
        logEvent("error", "node.http-bridge-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "İstek işlenemedi." }));
      });
  });

  const host = options.host ?? env.ARCHIVE_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(env.ARCHIVE_HTTP_PORT ?? 8788);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const stopScheduler = (options.scheduler ?? true) ? startScheduler() : () => undefined;

  return {
    url: `http://${host}:${boundPort}`,
    server,
    db: runtime.db,
    async close() {
      stopScheduler();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
    },
  };
}
