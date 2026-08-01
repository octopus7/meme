import type { StoredBlob } from "./types";

const LEGACY_OWNER_SUB = "public";

export interface ImageRow {
  id: string;
  description: string;
  blob_hash: string;
  extension: string;
  original_filename: string;
  byte_size: number;
  created_at: string;
}

export type ExposureContext = "all" | "search";

export interface ImageUrlExposureRow {
  id: number;
  exposed_at: number;
  image_item_id: string;
  blob_hash: string;
  original_filename: string;
  byte_size: number;
  exposure_context: ExposureContext;
  viewer_sub: string;
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/u).filter(Boolean))].slice(0, 8);
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function search(env: Env, ownerSub: string, query: string, limit: number): Promise<ImageRow[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const clauses = terms.map(() => "(i.description LIKE ? ESCAPE '\\' OR i.original_filename LIKE ? ESCAPE '\\')");
  const params: unknown[] = [ownerSub];
  for (const term of terms) params.push(likePattern(term), likePattern(term));
  params.push(limit);
  const result = await env.DB.prepare(
    `SELECT i.id, i.description, i.blob_hash, b.extension,
            i.original_filename, b.byte_size, i.created_at
     FROM image_items i JOIN blobs b ON b.hash = i.blob_hash
     WHERE b.state = 'active'
       AND i.owner_sub = ?
       AND ${clauses.join(" AND ")}
     ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
  ).bind(...params).all<ImageRow>();
  return result.results;
}

export async function list(env: Env, ownerSub: string, cursor: string | null, limit: number): Promise<ImageRow[]> {
  const decoded = cursor ? decodeCursor(cursor) : null;
  const sql = decoded
    ? `SELECT i.id, i.description, i.blob_hash, b.extension,
              i.original_filename, b.byte_size, i.created_at
       FROM image_items i JOIN blobs b ON b.hash=i.blob_hash
       WHERE b.state='active'
       AND i.owner_sub=?
       AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
    : `SELECT i.id, i.description, i.blob_hash, b.extension,
              i.original_filename, b.byte_size, i.created_at
       FROM image_items i JOIN blobs b ON b.hash=i.blob_hash
       WHERE b.state='active'
       AND i.owner_sub=?
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`;
  const values = decoded
    ? [ownerSub, decoded.createdAt, decoded.createdAt, decoded.id, limit]
    : [ownerSub, limit];
  const result = await env.DB.prepare(sql).bind(...values).all<ImageRow>();
  return result.results;
}

export function encodeCursor(row: ImageRow): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function writeImageUrlExposures(
  env: Env,
  rows: ImageRow[],
  viewerSub: string,
  exposureContext: ExposureContext,
): Promise<void> {
  const exposedAt = Math.floor(Date.now() / 1000);
  const unique = new Map(rows.map((row) => [row.id, row]));
  if (!unique.size) return;
  await env.DB.batch([...unique.values()].map((row) => env.DB.prepare(
    `INSERT INTO image_url_exposure_logs
       (exposed_at, image_item_id, blob_hash, original_filename, byte_size, exposure_context, viewer_sub)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    exposedAt,
    row.id,
    row.blob_hash,
    row.original_filename,
    row.byte_size,
    exposureContext,
    viewerSub,
  )));
}

export async function imageUrlExposures(
  env: Env,
  from: number,
  to: number,
  beforeAt: number | null,
  beforeId: number | null,
  limit: number,
): Promise<ImageUrlExposureRow[]> {
  const hasCursor = beforeAt !== null && beforeId !== null;
  const before = hasCursor
    ? "AND (e.exposed_at < ? OR (e.exposed_at = ? AND e.id < ?))"
    : "";
  const values = hasCursor
    ? [from, to, beforeAt, beforeAt, beforeId, limit]
    : [from, to, limit];
  const result = await env.DB.prepare(
    `SELECT e.id, e.exposed_at, e.image_item_id, e.blob_hash,
            e.original_filename, e.byte_size, e.exposure_context, e.viewer_sub
     FROM image_url_exposure_logs e
     WHERE e.exposed_at >= ? AND e.exposed_at < ? ${before}
     ORDER BY e.exposed_at DESC, e.id DESC
     LIMIT ?`,
  ).bind(...values).all<ImageUrlExposureRow>();
  return result.results;
}

export async function purgeExpiredImageUrlExposures(env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM image_url_exposure_logs
     WHERE id IN (
       SELECT id FROM image_url_exposure_logs
       WHERE exposed_at < unixepoch() - ?
       ORDER BY exposed_at
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

export async function adoptLegacyItems(env: Env, ownerSub: string, ownerEmail: string): Promise<void> {
  const legacy = await env.DB.prepare(
    "SELECT 1 AS found FROM image_items WHERE owner_sub=? LIMIT 1",
  ).bind(LEGACY_OWNER_SUB).first<{ found: number }>();
  if (!legacy) return;
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM image_items
       WHERE owner_sub=? AND EXISTS (
         SELECT 1 FROM image_items owned
         WHERE owned.owner_sub=? AND owned.blob_hash=image_items.blob_hash
       )`,
    ).bind(LEGACY_OWNER_SUB, ownerSub),
    env.DB.prepare(
      "UPDATE image_items SET owner_sub=?, owner_email=? WHERE owner_sub=?",
    ).bind(ownerSub, ownerEmail, LEGACY_OWNER_SUB),
  ]);
}

export async function addItem(
  env: Env,
  ownerSub: string,
  ownerEmail: string,
  blob: StoredBlob,
  description: string,
  filename: string,
): Promise<string> {
  const current = await env.DB.prepare("SELECT state FROM blobs WHERE hash=?").bind(blob.hash).first<{ state: string }>();
  if (current && current.state !== "active") throw new Error("Blob is not active");
  const existing = await env.DB.prepare(
    "SELECT id FROM image_items WHERE owner_sub=? AND blob_hash=?"
  ).bind(ownerSub, blob.hash).first<{ id: string }>();
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
    ).bind(id, ownerSub, ownerEmail, blob.hash, description, filename)
  ]);
  const row = await env.DB.prepare("SELECT id FROM image_items WHERE owner_sub=? AND blob_hash=?")
    .bind(ownerSub, blob.hash).first<{ id: string }>();
  if (!row) throw new Error("Failed to store image metadata");
  return row.id;
}
