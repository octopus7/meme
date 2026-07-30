import type { StoredBlob, User } from "./types";

export interface ImageRow {
  id: string;
  description: string;
  blob_hash: string;
  extension: string;
  created_at: string;
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/u).filter(Boolean))].slice(0, 8);
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function search(env: Env, user: User, query: string, limit: number): Promise<ImageRow[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const clauses = terms.map(() => "(i.description LIKE ? ESCAPE '\\' OR i.original_filename LIKE ? ESCAPE '\\')");
  const params: unknown[] = [user.sub];
  for (const term of terms) params.push(likePattern(term), likePattern(term));
  params.push(limit);
  const result = await env.DB.prepare(
    `SELECT i.id, i.description, i.blob_hash, b.extension, i.created_at
     FROM image_items i JOIN blobs b ON b.hash = i.blob_hash
     WHERE i.owner_sub = ? AND b.state = 'active' AND ${clauses.join(" AND ")}
     ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
  ).bind(...params).all<ImageRow>();
  return result.results;
}

export async function list(env: Env, user: User, cursor: string | null, limit: number): Promise<ImageRow[]> {
  const decoded = cursor ? decodeCursor(cursor) : null;
  const sql = decoded
    ? `SELECT i.id, i.description, i.blob_hash, b.extension, i.created_at
       FROM image_items i JOIN blobs b ON b.hash=i.blob_hash
       WHERE i.owner_sub=? AND b.state='active'
       AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`
    : `SELECT i.id, i.description, i.blob_hash, b.extension, i.created_at
       FROM image_items i JOIN blobs b ON b.hash=i.blob_hash
       WHERE i.owner_sub=? AND b.state='active'
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`;
  const values = decoded
    ? [user.sub, decoded.createdAt, decoded.createdAt, decoded.id, limit]
    : [user.sub, limit];
  const result = await env.DB.prepare(sql).bind(...values).all<ImageRow>();
  return result.results;
}

export function encodeCursor(row: ImageRow): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
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

export async function addItem(env: Env, user: User, blob: StoredBlob, description: string, filename: string): Promise<string> {
  const current = await env.DB.prepare("SELECT state FROM blobs WHERE hash=?").bind(blob.hash).first<{ state: string }>();
  if (current && current.state !== "active") throw new Error("Blob is not active");
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
    ).bind(id, user.sub, user.email, blob.hash, description, filename)
  ]);
  const row = await env.DB.prepare("SELECT id FROM image_items WHERE owner_sub=? AND blob_hash=?")
    .bind(user.sub, blob.hash).first<{ id: string }>();
  if (!row) throw new Error("Failed to store image metadata");
  return row.id;
}
