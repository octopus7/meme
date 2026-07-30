import { ALL_JS, SEARCH_JS, UPLOAD_JS } from "./assets";
import { authenticate } from "./auth";
import { addItem, encodeCursor, list, search, searchTerms, type ImageRow } from "./db";
import { escapeHtml, highlight, html, textBytes } from "./html";
import type { StoredBlob } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: JSON_HEADERS });
}

function imageOrigin(env: Env): string {
  return env.IMAGE_ORIGIN.replace(/\/+$/u, "");
}

function imageMarkup(row: ImageRow, env: Env, terms: string[] = [], deletable = false): string {
  const hash = encodeURIComponent(row.blob_hash);
  const ext = encodeURIComponent(row.extension);
  const origin = escapeHtml(imageOrigin(env));
  const remove = deletable ? `<button type="button" data-delete="${escapeHtml(row.id)}">delete</button>` : "";
  return `<article><a href="${origin}/i/${hash}.${ext}"><img src="${origin}/t/${hash}" width="128" height="128" loading="lazy" alt=""></a><p>${highlight(row.description, terms)}</p>${remove}</article>`;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

function decodeHeader(request: Request, name: string): string {
  const value = request.headers.get(name) ?? "";
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}

function validBlob(value: unknown): value is StoredBlob {
  if (!value || typeof value !== "object") return false;
  const blob = value as Record<string, unknown>;
  return typeof blob.hash === "string" && /^[a-f0-9]{64}$/u.test(blob.hash)
    && typeof blob.extension === "string" && /^[a-z0-9]{2,5}$/u.test(blob.extension)
    && typeof blob.mimeType === "string" && blob.mimeType.startsWith("image/")
    && typeof blob.size === "number" && Number.isSafeInteger(blob.size) && blob.size >= 0;
}

async function upload(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Forbidden origin" }, 403);
  const length = Number(request.headers.get("content-length"));
  const max = Number(env.MAX_UPLOAD_BYTES ?? "20971520");
  if (!Number.isSafeInteger(length) || length < 1) return json({ error: "Content-Length is required" }, 411);
  if (length > max) return json({ error: "Image is too large" }, 413);
  if (!request.body) return json({ error: "Image body is required" }, 400);

  let description: string;
  let filename: string;
  try {
    description = decodeHeader(request, "x-description").trim();
    filename = decodeHeader(request, "x-original-filename").trim();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid metadata" }, 400);
  }
  if (!description || description.length > 500 || textBytes(description) > 2000) {
    return json({ error: "Description must be 1-500 characters" }, 400);
  }
  if (!filename || filename.length > 255 || textBytes(filename) > 1024) {
    return json({ error: "Filename must be 1-255 characters" }, 400);
  }

  const storageResponse = await env.STORAGE_ADMIN.fetch("https://storage.internal/internal/v1/blobs", {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/octet-stream",
      "content-length": String(length)
    },
    body: request.body
  });
  if (!storageResponse.ok) {
    return json({ error: "Image storage rejected the upload" }, storageResponse.status >= 400 && storageResponse.status < 500 ? storageResponse.status : 502);
  }
  const value: unknown = await storageResponse.json();
  if (!validBlob(value)) return json({ error: "Invalid response from image storage" }, 502);
  try {
    const id = await addItem(env, value, description, filename);
    return json({ id, hash: value.hash }, 201);
  } catch (error) {
    console.error(JSON.stringify({ event: "metadata_write_failed", hash: value.hash, error: String(error) }));
    return json({ error: "Could not save image metadata" }, 409);
  }
}

async function removeImage(id: string, request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Forbidden origin" }, 403);
  const row = await env.DB.prepare("SELECT blob_hash FROM image_items WHERE id=?")
    .bind(id).first<{ blob_hash: string }>();
  if (!row) return json({ error: "Not found" }, 404);

  await env.DB.prepare("DELETE FROM image_items WHERE blob_hash=?").bind(row.blob_hash).run();
  await env.DB.prepare(
    `UPDATE blobs SET state='trash_pending'
     WHERE hash=? AND state='active'
       AND NOT EXISTS (SELECT 1 FROM image_items WHERE blob_hash=?)`
  ).bind(row.blob_hash, row.blob_hash).run();
  const blob = await env.DB.prepare("SELECT state FROM blobs WHERE hash=?")
    .bind(row.blob_hash).first<{ state: string }>();
  if (blob?.state !== "trash_pending") return new Response(null, { status: 204 });

  const trashed = await trashBlob(env, row.blob_hash);
  if (!trashed) return json({ error: "Deleted; storage cleanup is pending" }, 202);
  return new Response(null, { status: 204 });
}

async function trashBlob(env: Env, hash: string): Promise<boolean> {
  try {
    const response = await env.STORAGE_ADMIN.fetch(`https://storage.internal/internal/v1/blobs/${hash}/trash`, { method: "POST" });
    if (!response.ok && response.status !== 404 && response.status !== 409) return false;
    await env.DB.prepare(
      "UPDATE blobs SET state='trashed', trashed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), purge_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days') WHERE hash=? AND state='trash_pending'"
    ).bind(hash).run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: "trash_failed", hash, error: String(error) }));
    return false;
  }
}

async function retryPendingTrash(env: Env): Promise<void> {
  const pending = await env.DB.prepare("SELECT hash FROM blobs WHERE state='trash_pending' LIMIT 50").all<{ hash: string }>();
  for (const row of pending.results) await trashBlob(env, row.hash);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return Response.redirect(new URL("/search", url), 302);
  if (request.method === "GET" && url.pathname === "/assets/search.js") {
    return new Response(SEARCH_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/upload.js") {
    return new Response(UPLOAD_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/assets/all.js") {
    return new Response(ALL_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/search") {
    return html(`<main><form role="search"><input name="q" aria-label="검색어" autocomplete="off"></form><p><a href="/all">all</a></p><div id="results"></div></main><script src="/assets/search.js" defer></script>`);
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    if (!query) return new Response("", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
    const rows = await search(env, query, 5);
    const body = rows.map((row) => imageMarkup(row, env, searchTerms(query))).join("");
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  if (request.method === "GET" && url.pathname === "/all") {
    let rows: ImageRow[];
    try {
      rows = await list(env, url.searchParams.get("cursor"), 51);
    } catch {
      return html("<p>잘못된 페이지 주소입니다.</p>", 400);
    }
    const hasMore = rows.length > 50;
    const visible = rows.slice(0, 50);
    const next = hasMore && visible.length ? `<p><a href="/all?cursor=${encodeURIComponent(encodeCursor(visible[visible.length - 1]!))}">next</a></p>` : "";
    return html(`<nav><a href="/search">search</a> <a href="/upload">upload</a></nav><main>${visible.map((row) => imageMarkup(row, env, [], true)).join("")}${next}</main><script src="/assets/all.js" defer></script>`);
  }
  if (request.method === "GET" && url.pathname === "/upload") {
    return html(`<nav><a href="/search">search</a> <a href="/all">all</a></nav><main><form><input name="image" type="file" accept="image/*" required><input name="description" aria-label="설명" maxlength="500" required><button>upload</button></form><p id="message"></p></main><script src="/assets/upload.js" defer></script>`);
  }
  if (request.method === "POST" && url.pathname === "/api/images") return upload(request, env);
  const match = /^\/api\/images\/([0-9a-f-]{36})$/u.exec(url.pathname);
  if (request.method === "DELETE" && match?.[1]) return removeImage(match[1], request, env);
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const authentication = await authenticate(request, env);
      if (authentication) return authentication;
      return await route(request, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname, error: String(error) }));
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(retryPendingTrash(env));
  }
} satisfies ExportedHandler<Env>;
