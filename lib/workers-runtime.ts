/**
 * Workers çalışma zamanı önyüklemesi (kurum içi port P1).
 *
 * Depo genelinde `cloudflare:workers` sanal modülünü içe aktaran TEK dosya
 * budur; pilotun bağlamalarını (D1, R2, worker sırları) dikişe kaydeder.
 * Kurum içi Node build'i (P4) bu modülü, `createNodeEnvBindingsProvider` ile
 * process.env + MinIO/SQLite adaptörlerini kaydeden Node önyüklemesiyle takas
 * eder (vite/bundler alias); başka hiçbir dosyanın değişmesi gerekmez.
 */

import { env } from "cloudflare:workers";

import { setArchiveBindingsProvider, type ArchiveBindings } from "./archive-bindings.ts";

setArchiveBindingsProvider(() => env as unknown as Partial<ArchiveBindings>);
