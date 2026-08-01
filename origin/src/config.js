import path from "node:path";

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function durationMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(raw.trim());
  if (!match) throw new Error(`${name} must use ms, s, m, h, or d`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const value = Number(match[1]) * factors[match[2]];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is outside the supported range`);
  }
  return value;
}

function directory(name, fallback) {
  const value = (process.env[name] || fallback).trim();
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function commitSha() {
  const value = (process.env.MEME_ORIGIN_COMMIT_SHA || "unknown").trim();
  if (value !== "unknown" && !/^[0-9a-f]{7,40}$/.test(value)) {
    throw new Error("MEME_ORIGIN_COMMIT_SHA must be a hexadecimal commit SHA or unknown");
  }
  return value;
}

export function loadConfig() {
  const token = process.env.MEME_ORIGIN_MUTATION_TOKEN || "";
  if (token.length < 32 || token.startsWith("replace-")) {
    throw new Error("MEME_ORIGIN_MUTATION_TOKEN must be a non-placeholder value of at least 32 characters");
  }
  return Object.freeze({
    commitSha: commitSha(),
    host: (process.env.MEME_ORIGIN_HOST || "127.0.0.1").trim(),
    port: positiveInteger("MEME_ORIGIN_PORT", 8086),
    dataDir: directory("MEME_ORIGIN_DATA_DIR", "/var/lib/meme-origin"),
    accessLogDir: directory("MEME_ORIGIN_ACCESS_LOG_DIR", "/var/log/meme-origin"),
    mutationToken: token,
    maxUploadBytes: positiveInteger("MEME_ORIGIN_MAX_UPLOAD_BYTES", 25 * 1024 * 1024),
    maxImagePixels: positiveInteger("MEME_ORIGIN_MAX_IMAGE_PIXELS", 80_000_000),
    trashRetentionMs: durationMs("MEME_ORIGIN_TRASH_RETENTION", 30 * 86_400_000),
    purgeIntervalMs: durationMs("MEME_ORIGIN_PURGE_INTERVAL", 86_400_000),
    requestTimeoutMs: durationMs("MEME_ORIGIN_REQUEST_TIMEOUT", 120_000),
    shutdownTimeoutMs: durationMs("MEME_ORIGIN_SHUTDOWN_TIMEOUT", 20_000),
    imageConcurrency: positiveInteger("MEME_ORIGIN_IMAGE_CONCURRENCY", 1),
  });
}
