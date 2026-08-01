import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AccessLogger } from "../src/access-log.js";
import { createOriginServer } from "../src/server.js";
import { ImageStore } from "../src/store.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "meme-origin-test-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    commitSha: "test-commit",
    dataDir: path.join(root, "data"),
    accessLogDir: path.join(root, "logs"),
    mutationToken: TOKEN,
    maxUploadBytes: 2 * 1024 * 1024,
    maxImagePixels: 1_000_000,
    trashRetentionMs: 30 * 86_400_000,
    purgeIntervalMs: 86_400_000,
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 2_000,
    imageConcurrency: 1,
  };
  const store = await new ImageStore(config).init();
  const accessLogger = await new AccessLogger(config.accessLogDir).init();
  return {
    root,
    config,
    store,
    accessLogger,
    async close() {
      await accessLogger.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function png() {
  return sharp({
    create: { width: 320, height: 180, channels: 4, background: "#336699ff" },
  }).png().toBuffer();
}

test("upload, canonical contract, dedup, trash and restore", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const content = await png();
  const first = await f.store.put(Readable.from(content));
  assert.deepEqual(Object.keys(first).sort(), ["deduplicated", "extension", "hash", "mimeType", "size"].sort());
  assert.equal(first.extension, "png");
  assert.equal(first.mimeType, "image/png");
  assert.equal(first.deduplicated, false);
  assert.equal((await f.store.put(Readable.from(content))).deduplicated, true);
  const thumbnail = await f.store.resolveThumbnail(first.hash);
  const metadata = await sharp(await readFile(thumbnail.filename)).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 128);
  await f.store.trash(first.hash);
  await assert.rejects(f.store.resolveOriginal(first.hash, "png"), { code: "NOT_FOUND" });
  await assert.rejects(f.store.put(Readable.from(content)), { code: "TRASHED" });
  await f.store.restore(first.hash);
  assert.equal((await f.store.resolveOriginal(first.hash, "png")).info.size, content.length);
});

test("HTTP auth, ranges, conditional request, and trash 404", async (t) => {
  const f = await fixture();
  const server = createOriginServer({ config: f.config, store: f.store, accessLogger: f.accessLogger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  });
  const content = await png();
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", commit: "test-commit" });
  assert.equal((await fetch(`${base}/internal/v1/blobs`, { method: "POST", body: content })).status, 401);
  const uploadedResponse = await fetch(`${base}/internal/v1/blobs?secret=not-logged`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "origin-test" },
    body: content,
  });
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json();
  assert.equal(uploaded.mimeType, "image/png");
  assert.equal(uploaded.deduplicated, false);
  const mediaUrl = `${base}/i/${uploaded.hash}.png`;
  const media = await fetch(mediaUrl, { headers: { range: "bytes=0-9" } });
  assert.equal(media.status, 206);
  assert.equal(media.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(media.headers.get("cache-tag"), `blob-${uploaded.hash}`);
  assert.equal(media.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal((await media.arrayBuffer()).byteLength, 10);
  const etag = media.headers.get("etag");
  assert.equal((await fetch(mediaUrl, { headers: { "if-none-match": etag } })).status, 304);
  assert.equal((await fetch(`${base}/internal/v1/blobs/${uploaded.hash}/trash`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  })).status, 200);
  assert.equal((await fetch(mediaUrl)).status, 404);
  await f.accessLogger.close();
  const logName = (await readdir(f.config.accessLogDir)).find((name) => name.endsWith(".log"));
  const logText = await readFile(path.join(f.config.accessLogDir, logName), "utf8");
  assert(!logText.includes("not-logged"));
  assert(!logText.includes(TOKEN));
  assert(!logText.includes('"path":"/healthz"'));
  assert(logText.includes('"status":201'));
});

test("access log excludes secrets, rotates, and compresses after 30 days", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "meme-log-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger = await new AccessLogger(root).init();
  await logger.write({
    timestamp: "2026-07-30T00:00:00.000Z",
    method: "POST",
    path: "/upload",
    status: 201,
    bytes: 12,
    duration_ms: 1,
    remote_ip: "127.0.0.1",
    user_agent: "test",
  });
  await logger.write({
    timestamp: "2026-07-31T00:00:00.000Z",
    method: "GET",
    path: "/",
    status: 200,
    bytes: 0,
    duration_ms: 1,
  });
  const old = path.join(root, "access-2026-06-29.log");
  await writeFile(old, "{\"old\":true}\n");
  await logger.compressOld(new Date("2026-07-30T12:00:00Z"));
  const unzipped = gunzipSync(await readFile(`${old}.gz`)).toString();
  assert.equal(unzipped, "{\"old\":true}\n");
  await assert.rejects(readFile(old), { code: "ENOENT" });
  const names = await readdir(root);
  assert(names.includes("access-2026-07-30.log"));
  assert(names.includes("access-2026-07-31.log"));
  assert(!names.some((name) => name.includes(".tmp-")));
  await logger.close();
});
