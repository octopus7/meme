import { WorkerEntrypoint } from "cloudflare:workers";
import {
  canonicalMediaRequest,
  mediaTag,
  originMediaUrl,
  parseMediaPath,
  publicMediaResponse,
} from "./media";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FORWARDED_UPLOAD_HEADERS = [
  "content-type",
  "content-length",
  "x-meme-metadata",
] as const;

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function originAdminHeaders(env: Env, request?: Request): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${env.ORIGIN_ADMIN_TOKEN}`,
  });
  if (request) {
    for (const name of FORWARDED_UPLOAD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return headers;
}

export class Media extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "method not allowed");
    }

    const target = parseMediaPath(new URL(request.url).pathname);
    if (!target) return plain(404, "not found");

    try {
      const response = await this.env.ORIGIN.fetch(
        new Request(originMediaUrl(this.env.ORIGIN_BASE_URL, target), {
          method: request.method,
          headers: request.headers,
        }),
      );
      return publicMediaResponse(response, target.hash);
    } catch (error) {
      console.error(JSON.stringify({
        event: "origin_fetch_failed",
        path: target.path,
        error: error instanceof Error ? error.message : "unknown",
      }));
      return plain(502, "image origin unavailable");
    }
  }

  async invalidate(hash: string): Promise<void> {
    const cache = this.ctx.cache;
    if (!cache) throw new Error("Media entrypoint cache is not enabled");
    await cache.purge({ tags: [mediaTag(hash)] });
  }
}

export class Admin extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/internal/v1/healthz") {
      try {
        return await this.env.ORIGIN.fetch(
          new Request(`${this.env.ORIGIN_BASE_URL.replace(/\/$/, "")}/healthz`),
        );
      } catch {
        return plain(502, "origin unavailable");
      }
    }

    if (request.method === "POST" && url.pathname === "/internal/v1/blobs") {
      if (!request.body) return plain(400, "missing image body");
      try {
        return await this.env.ORIGIN.fetch(
          new Request(`${this.env.ORIGIN_BASE_URL.replace(/\/$/, "")}/internal/v1/blobs`, {
            method: "POST",
            headers: originAdminHeaders(this.env, request),
            body: request.body,
          }),
        );
      } catch (error) {
        console.error(JSON.stringify({
          event: "origin_upload_failed",
          error: error instanceof Error ? error.message : "unknown",
        }));
        return plain(502, "image origin unavailable");
      }
    }

    const trashMatch = /^\/internal\/v1\/blobs\/([0-9a-f]{64})\/trash$/.exec(url.pathname);
    if (request.method === "POST" && trashMatch) {
      const hash = trashMatch[1]!;
      if (!HASH_PATTERN.test(hash)) return plain(400, "invalid hash");

      try {
        const originResponse = await this.env.ORIGIN.fetch(
          new Request(
            `${this.env.ORIGIN_BASE_URL.replace(/\/$/, "")}/internal/v1/blobs/${hash}/trash`,
            {
              method: "POST",
              headers: originAdminHeaders(this.env),
            },
          ),
        );
        if (!originResponse.ok) return originResponse;

        await this.ctx.exports.Media.invalidate(hash);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({
          event: "origin_trash_or_purge_failed",
          hash,
          error: error instanceof Error ? error.message : "unknown",
        }));
        return plain(502, "trash operation incomplete");
      }
    }

    return plain(404, "not found");
  }
}

export default {
  async fetch(request, _env, ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "method not allowed");
    }

    const target = parseMediaPath(new URL(request.url).pathname);
    if (!target) return plain(404, "not found");

    return ctx.exports.Media.fetch(canonicalMediaRequest(request, target));
  },
} satisfies ExportedHandler<Env>;
