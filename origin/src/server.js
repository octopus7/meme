import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { STORE_ERRORS } from "./store.js";

const HASH = "[a-f0-9]{64}";
const ORIGINAL_PATH = new RegExp(`^/i/(${HASH})\\.(jpg|png|webp|gif)$`);
const THUMBNAIL_PATH = new RegExp(`^/t/(${HASH})$`);
const TRASH_PATH = new RegExp(`^/internal/v1/blobs/(${HASH})/trash$`);
const RESTORE_PATH = new RegExp(`^/internal/v1/blobs/(${HASH})/restore$`);
const MIME = Object.freeze({
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
});

export function createOriginServer({ config, store, accessLogger, logger = console }) {
  const server = createServer((request, response) => {
    if (safePath(request.url) !== "/healthz") {
      accessLogger?.observe(request, response);
    }
    setSecurityHeaders(response);
    route(request, response, { config, store }).catch((error) => {
      logger.error("request failed", {
        method: request.method,
        path: safePath(request.url),
        error: error?.message,
      });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      handleError(response, error);
    });
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function route(request, response, context) {
  const pathname = safePath(request.url);
  if (request.method === "GET" && pathname === "/healthz") {
    json(response, 200, { status: "ok" });
    return;
  }
  let match = ORIGINAL_PATH.exec(pathname);
  if (match && (request.method === "GET" || request.method === "HEAD")) {
    const media = await context.store.resolveOriginal(match[1], match[2]);
    await serveMedia(request, response, media, MIME[match[2]], `"${match[1]}"`, match[1]);
    return;
  }
  match = THUMBNAIL_PATH.exec(pathname);
  if (match && (request.method === "GET" || request.method === "HEAD")) {
    const media = await context.store.resolveThumbnail(match[1]);
    await serveMedia(request, response, media, "image/webp", `"${match[1]}-thumb"`, match[1]);
    return;
  }
  if (request.method === "POST" && pathname === "/internal/v1/blobs") {
    authorize(request, context.config.mutationToken);
    const result = await context.store.put(request);
    json(response, 201, result);
    return;
  }
  match = TRASH_PATH.exec(pathname);
  if (request.method === "POST" && match) {
    authorize(request, context.config.mutationToken);
    json(response, 200, await context.store.trash(match[1]));
    return;
  }
  match = RESTORE_PATH.exec(pathname);
  if (request.method === "POST" && match) {
    authorize(request, context.config.mutationToken);
    json(response, 200, await context.store.restore(match[1]));
    return;
  }
  if (request.method === "POST" && pathname === "/internal/v1/admin/purge") {
    authorize(request, context.config.mutationToken);
    json(response, 200, { purged: await context.store.purgeExpired() });
    return;
  }
  throw Object.assign(new Error("not found"), { code: STORE_ERRORS.NOT_FOUND });
}

function safePath(requestUrl) {
  try {
    return new URL(requestUrl, "http://origin.invalid").pathname;
  } catch {
    return "/";
  }
}

function authorize(request, expected) {
  const prefix = "Bearer ";
  const value = request.headers.authorization || "";
  const supplied = value.startsWith(prefix) ? value.slice(prefix.length).trim() : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw Object.assign(new Error("unauthorized"), { code: "UNAUTHORIZED" });
  }
}

async function serveMedia(request, response, media, contentType, etag, hash) {
  const modified = media.info.mtime.toUTCString();
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  response.setHeader("Cache-Tag", `blob-${hash}`);
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("ETag", etag);
  response.setHeader("Last-Modified", modified);
  if (notModified(request, etag, media.info.mtime)) {
    response.statusCode = 304;
    response.end();
    return;
  }
  let start = 0;
  let end = media.info.size - 1;
  if (request.headers.range) {
    const range = parseRange(request.headers.range, media.info.size);
    if (!range) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${media.info.size}`);
      response.end();
      return;
    }
    ({ start, end } = range);
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${media.info.size}`);
  } else {
    response.statusCode = 200;
  }
  response.setHeader("Content-Length", end - start + 1);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(media.filename, { start, end });
    stream.once("error", reject);
    response.once("close", resolve);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

function notModified(request, etag, modified) {
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch) {
    return ifNoneMatch === "*" || ifNoneMatch.split(",").some((value) => value.trim() === etag);
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  return Number.isFinite(since) && Math.floor(modified.getTime() / 1000) <= Math.floor(since / 1000);
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function handleError(response, error) {
  response.setHeader("Cache-Control", "no-store");
  switch (error?.code) {
    case "UNAUTHORIZED":
      response.setHeader("WWW-Authenticate", "Bearer");
      json(response, 401, { error: "unauthorized" });
      break;
    case STORE_ERRORS.NOT_FOUND:
      json(response, 404, { error: "not found" });
      break;
    case STORE_ERRORS.TRASHED:
      json(response, 409, { error: "blob is in trash and requires administrator restore" });
      break;
    case STORE_ERRORS.CONFLICT:
      json(response, 409, { error: "blob state conflict" });
      break;
    case STORE_ERRORS.TOO_LARGE:
    case STORE_ERRORS.UNSUPPORTED:
      json(response, 400, { error: error.message });
      break;
    default:
      json(response, 500, { error: "internal error" });
  }
}

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", body.length);
  response.end(body);
}
