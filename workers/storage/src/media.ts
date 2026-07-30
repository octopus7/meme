const ORIGINAL_PATTERN = /^\/i\/([0-9a-f]{64})\.(jpg|png|webp|gif)$/;
const THUMB_PATTERN = /^\/t\/([0-9a-f]{64})$/;

export type MediaTarget = {
  readonly hash: string;
  readonly path: string;
  readonly kind: "original" | "thumbnail";
};

export function parseMediaPath(pathname: string): MediaTarget | null {
  const original = ORIGINAL_PATTERN.exec(pathname);
  if (original) {
    return { hash: original[1]!, path: pathname, kind: "original" };
  }

  const thumbnail = THUMB_PATTERN.exec(pathname);
  if (thumbnail) {
    return { hash: thumbnail[1]!, path: pathname, kind: "thumbnail" };
  }

  return null;
}

export function canonicalMediaRequest(request: Request, target: MediaTarget): Request {
  const headers = new Headers();
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Request(`https://media-cache.internal${target.path}`, {
    method: request.method,
    headers,
  });
}

export function originMediaUrl(baseUrl: string, target: MediaTarget): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${target.path}`;
}

export function publicMediaResponse(origin: Response, hash: string): Response {
  const headers = new Headers();
  const copied = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const name of copied) {
    const value = origin.headers.get(name);
    if (value) headers.set(name, value);
  }

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");

  if (origin.status === 200 || origin.status === 206 || origin.status === 304) {
    headers.set("Cache-Control", "public, no-cache");
    headers.set("Cloudflare-CDN-Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Cache-Tag", `blob-${hash}`);
  } else {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(origin.body, {
    status: origin.status,
    statusText: origin.statusText,
    headers,
  });
}

export function mediaTag(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError("invalid SHA-256 hash");
  return `blob-${hash}`;
}
