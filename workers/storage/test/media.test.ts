import { describe, expect, it } from "vitest";
import {
  canonicalMediaRequest,
  mediaTag,
  originMediaUrl,
  parseMediaPath,
  publicMediaResponse,
} from "../src/media";

const hash = "a".repeat(64);

describe("media paths", () => {
  it("accepts canonical original and thumbnail paths", () => {
    expect(parseMediaPath(`/i/${hash}.jpg`)).toEqual({
      hash,
      path: `/i/${hash}.jpg`,
      kind: "original",
    });
    expect(parseMediaPath(`/t/${hash}`)?.kind).toBe("thumbnail");
  });

  it("rejects traversal, uppercase hashes, and unknown extensions", () => {
    expect(parseMediaPath(`/i/../${hash}.jpg`)).toBeNull();
    expect(parseMediaPath(`/i/${hash.toUpperCase()}.jpg`)).toBeNull();
    expect(parseMediaPath(`/i/${hash}.svg`)).toBeNull();
  });

  it("drops cache-busting query strings and credentials", () => {
    const target = parseMediaPath(`/t/${hash}`)!;
    const request = new Request(`https://images.example/t/${hash}?random=1`, {
      headers: { Cookie: "secret", Range: "bytes=0-10" },
    });
    const canonical = canonicalMediaRequest(request, target);
    expect(canonical.url).toBe(`https://media-cache.internal/t/${hash}`);
    expect(canonical.headers.get("cookie")).toBeNull();
    expect(canonical.headers.get("range")).toBe("bytes=0-10");
    expect(originMediaUrl("http://origin.internal:8086/", target))
      .toBe(`http://origin.internal:8086/t/${hash}`);
  });
});

describe("media responses", () => {
  it("sets immutable edge caching and a shared blob tag", async () => {
    const response = publicMediaResponse(
      new Response("image", { headers: { "Content-Type": "image/webp" } }),
      hash,
    );
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toContain("31536000");
    expect(response.headers.get("Cache-Tag")).toBe(mediaTag(hash));
    expect(await response.text()).toBe("image");
  });

  it("does not cache missing content", () => {
    const response = publicMediaResponse(new Response(null, { status: 404 }), hash);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Cache-Tag")).toBe(false);
  });
});
