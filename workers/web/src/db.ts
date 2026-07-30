import type { StoredBlob } from "./types";

const LEGACY_OWNER_SUB = "public";
const LEGACY_OWNER_EMAIL = "public@localhost";

export interface ImageRow {
  id: string;
  description: string;
  blob_hash: string;
  extension: string;
  created_at: string;
}

export interface MediaRequestLogRow {
  id: number;
  requested_at: number;
  blob_hash: string;
  media_kind: "original" | "thumbnail";
  request_method: "GET" | "HEAD";
  cache_status: string;
  response_status: number;
  colo: string | null;
  extension: string | null;
  description: string | null;
}

export interface MediaFileStatsRow {
  blob_hash: string;
  extension: string | null;
  description: string | null;
  total_requests: number;
  cache_hits: number;
  cache_misses: number;
  cache_other: number;
  response_errors: number;
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/u).filter(Boolean))].slice(0, 8);
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function search(env: Env, query: string, limit: number): Promise<ImageRow[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const clauses = terms.map(() => "(i.description LIKE ? ESCAPE '\\' OR i.original_filename LIKE ? ESCAPE '\\')");
  const params: unknown[] = [];
  for (const term of terms) params.push(likePattern(term), likePattern(term));
  params.push(limit);
  const result = await env.DB.prepare(
    `SELECT i.id, i.description, i.blob_hash, b.extension, i.created_at
     FROM image_items i JOIN blobs b ON b.hash = i.blob_hash
     WHERE b.state = 'active'
       AND i.id = (
         SELECT duplicate.id FROM image_items duplicate
         WHERE duplicate.blob_hash=i.blob_hash
         ORDER BY duplicate.created_at, duplicate.id LIMIT 1
       )
       AND ${clauses.join(" AND ")}
     ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
  ).bind(...params).all<ImageRow>();
  return result.results;
}

export async function list(env: Env, cursor: string | null, limit: number): Promise<ImageRow[]> {
  const decoded = cursor ? decodeCursor(cursor) : null;
  const sql = decoded
    ? `SELECT i.id, i.description, i.blob_hash, b.extension, i.created_at
       FROM image_items i JOIN blobs b ON b.hash=i.blob_hash
       WHERE b.state='active'
       AND i.id = (
         SELECT duplicate.id FROM image_items duplicate
         WHERE duplicate.blob_hash=i.blob_hash
         ORDER BY duplicate.created_at, duplicate.id LIMIT 1
       )
       AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
    : `SELECT i.id, i.description, i.blob_hash, b.extension, i.created_at
       FROM image_items i JOIN blobs b ON b.hash=i.blob_hash
       WHERE b.state='active'
       AND i.id = (
         SELECT duplicate.id FROM image_items duplicate
         WHERE duplicate.blob_hash=i.blob_hash
         ORDER BY duplicate.created_at, duplicate.id LIMIT 1
       )
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`;
  const values = decoded
    ? [decoded.createdAt, decoded.createdAt, decoded.id, limit]
    : [limit];
  const result = await env.DB.prepare(sql).bind(...values).all<ImageRow>();
  return result.results;
}

export function encodeCursor(row: ImageRow): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function mediaRequestLogs(
  env: Env,
  from: number,
  to: number,
  beforeAt: number | null,
  beforeId: number | null,
  limit: number,
): Promise<MediaRequestLogRow[]> {
  const hasCursor = beforeAt !== null && beforeId !== null;
  const before = hasCursor
    ? "AND (l.requested_at < ? OR (l.requested_at = ? AND l.id < ?))"
    : "";
  const values = hasCursor
    ? [from, to, beforeAt, beforeAt, beforeId, limit]
    : [from, to, limit];
  const result = await env.DB.prepare(
    `SELECT l.id, l.requested_at, l.blob_hash, l.media_kind, l.request_method,
            l.cache_status, l.response_status, l.colo, b.extension,
            (SELECT i.description FROM image_items i
             WHERE i.blob_hash=l.blob_hash
             ORDER BY i.created_at, i.id LIMIT 1) AS description
     FROM media_request_logs l
     LEFT JOIN blobs b ON b.hash=l.blob_hash
     WHERE l.requested_at >= ? AND l.requested_at < ? ${before}
     ORDER BY l.requested_at DESC, l.id DESC
     LIMIT ?`,
  ).bind(...values).all<MediaRequestLogRow>();
  return result.results;
}

export async function mediaFileStats(
  env: Env,
  from: number,
  to: number,
): Promise<MediaFileStatsRow[]> {
  const result = await env.DB.prepare(
    `SELECT l.blob_hash, b.extension,
            (SELECT i.description FROM image_items i
             WHERE i.blob_hash=l.blob_hash
             ORDER BY i.created_at, i.id LIMIT 1) AS description,
            COUNT(*) AS total_requests,
            SUM(CASE WHEN l.cache_status='HIT' THEN 1 ELSE 0 END) AS cache_hits,
            SUM(CASE WHEN l.cache_status='MISS' THEN 1 ELSE 0 END) AS cache_misses,
            SUM(CASE WHEN l.cache_status NOT IN ('HIT', 'MISS') THEN 1 ELSE 0 END) AS cache_other,
            SUM(CASE WHEN l.response_status >= 400 THEN 1 ELSE 0 END) AS response_errors
     FROM media_request_logs l
     LEFT JOIN blobs b ON b.hash=l.blob_hash
     WHERE l.requested_at >= ? AND l.requested_at < ?
     GROUP BY l.blob_hash, b.extension
     ORDER BY total_requests DESC, l.blob_hash`,
  ).bind(from, to).all<MediaFileStatsRow>();
  return result.results;
}

export async function purgeExpiredMediaRequestLogs(env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM media_request_logs
     WHERE id IN (
       SELECT id FROM media_request_logs
       WHERE requested_at < unixepoch() - ?
       ORDER BY requested_at
       LIMIT 10000
     )`,
  ).bind(90 * 24 * 60 * 60).run();
}

export async function externalMembersAllowed(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key='allow_external_members'",
  ).first<{ value: string }>();
  return row?.value === "true";
}

export async function setExternalMembersAllowed(env: Env, allowed: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings(key, value)
     VALUES('allow_external_members', ?)
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(allowed ? "true" : "false").run();
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const value = parsed as Record<string, unknown>;
    if (typeof value.createdAt !== "string" || typeof value.id !== "string") throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new Error("Invalid cursor");
  }
}

export async function addItem(env: Env, blob: StoredBlob, description: string, filename: string): Promise<string> {
  const current = await env.DB.prepare("SELECT state FROM blobs WHERE hash=?").bind(blob.hash).first<{ state: string }>();
  if (current && current.state !== "active") throw new Error("Blob is not active");
  const existing = await env.DB.prepare(
    "SELECT id FROM image_items WHERE blob_hash=? ORDER BY created_at, id LIMIT 1"
  ).bind(blob.hash).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE image_items SET description=?, original_filename=? WHERE id=?"
    ).bind(description, filename, existing.id).run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO blobs(hash, extension, mime_type, byte_size, state)
       VALUES(?, ?, ?, ?, 'active')
       ON CONFLICT(hash) DO NOTHING`
    ).bind(blob.hash, blob.extension, blob.mimeType, blob.size),
    env.DB.prepare(
      `INSERT INTO image_items(id, owner_sub, owner_email, blob_hash, description, original_filename)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_sub, blob_hash) DO UPDATE SET
         description=excluded.description, original_filename=excluded.original_filename`
    ).bind(id, LEGACY_OWNER_SUB, LEGACY_OWNER_EMAIL, blob.hash, description, filename)
  ]);
  const row = await env.DB.prepare("SELECT id FROM image_items WHERE owner_sub=? AND blob_hash=?")
    .bind(LEGACY_OWNER_SUB, blob.hash).first<{ id: string }>();
  if (!row) throw new Error("Failed to store image metadata");
  return row.id;
}
