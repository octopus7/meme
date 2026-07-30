import type { MediaTarget } from "./media";

function normalizedCacheStatus(response: Response): string {
  const value = response.headers.get("cf-cache-status")?.trim().toUpperCase();
  return value && /^[A-Z0-9_-]{1,32}$/u.test(value) ? value : "UNKNOWN";
}

function requestColo(request: Request): string | null {
  const value = request.cf?.colo;
  return typeof value === "string" && /^[A-Z]{3}$/u.test(value) ? value : null;
}

export async function writeMediaRequestLog(
  env: Env,
  request: Request,
  target: MediaTarget,
  response: Response,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO media_request_logs
       (requested_at, blob_hash, media_kind, request_method, cache_status, response_status, colo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    Math.floor(Date.now() / 1000),
    target.hash,
    target.kind,
    request.method,
    normalizedCacheStatus(response),
    response.status,
    requestColo(request),
  ).run();
}
