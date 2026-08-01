function baseUrl(env: Env): string {
  const value = env.ORIGIN_ADMIN_BASE_URL.trim().replace(/\/+$/u, "");
  if (!/^https:\/\//u.test(value)) throw new Error("ORIGIN_ADMIN_BASE_URL must use HTTPS");
  return value;
}

function adminHeaders(env: Env, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Authorization", `Bearer ${env.ORIGIN_ADMIN_TOKEN}`);
  return result;
}

export function originAdminFetch(env: Env, pathname: string, init: RequestInit = {}): Promise<Response> {
  if (!pathname.startsWith("/")) throw new TypeError("origin admin path must be absolute");
  return fetch(new Request(`${baseUrl(env)}${pathname}`, {
    ...init,
    headers: adminHeaders(env, init.headers),
  }));
}

function purgeApiUrl(env: Env): string {
  const zone = env.CF_ZONE_ID.trim();
  if (!/^[a-f0-9]{32}$/u.test(zone)) throw new Error("CF_ZONE_ID must be a 32-character hexadecimal ID");
  return `https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`;
}

export async function purgeMediaCache(env: Env, hash: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new TypeError("invalid media hash");
  const response = await fetch(purgeApiUrl(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_CACHE_PURGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tags: [`blob-${hash}`] }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Preserve the useful HTTP status below when Cloudflare returns a non-JSON response.
  }
  if (!response.ok || !body || typeof body !== "object" || (body as { success?: unknown }).success !== true) {
    throw new Error(`Cloudflare cache purge failed (${response.status})`);
  }
}
