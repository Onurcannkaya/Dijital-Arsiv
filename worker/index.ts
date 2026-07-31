/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runScheduledJob } from "../lib/scheduled-jobs.ts";
import { correlationId, logEvent } from "../lib/observability.ts";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ARCHIVE_FILES: R2Bucket;
  DERIVATIVE_FILES?: R2Bucket;
  TEMPORARY_FILES?: R2Bucket;
  QUARANTINE_FILES?: R2Bucket;
  OCR_SERVICE_URL?: string;
  OCR_SERVICE_TOKEN?: string;
  CONTENT_SCAN_SERVICE_URL?: string;
  CONTENT_SCAN_SERVICE_TOKEN?: string;
  DOCUMENT_RENDER_SERVICE_URL?: string;
  DOCUMENT_RENDER_SERVICE_TOKEN?: string;
  DOCUMENT_RENDER_IMAGE_DIGEST?: string;
  ARCHIVE_ADMIN_EMAILS?: string;
  ARCHIVE_MIGRATION_TOKEN?: string;
  APP_ENV?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = correlationId(request);
    const headers = new Headers(request.headers);
    headers.set("x-correlation-id", requestId);
    const forwardedRequest = new Request(request, { headers });
    const url = new URL(forwardedRequest.url);
    const started = Date.now();

    try {
      const response = url.pathname === "/_vinext/image"
        ? await handleImageOptimization(forwardedRequest, {
            fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, forwardedRequest.url))),
            transformImage: async (body, { width, format, quality }) => {
              const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
              return result.response();
            },
          }, [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES])
        : await handler.fetch(forwardedRequest, env, ctx);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("x-correlation-id", requestId);
      logEvent(response.status >= 500 ? "error" : "info", "http.request", {
        correlationId: requestId,
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - started,
      });
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch (error) {
      logEvent("error", "http.request", {
        correlationId: requestId,
        method: request.method,
        path: url.pathname,
        outcome: "exception",
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledJob(env, controller.cron));
  },
};

export default worker;
