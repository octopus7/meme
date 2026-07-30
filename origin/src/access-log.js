import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const LOG_PATTERN = /^access-(\d{4}-\d{2}-\d{2})\.log$/;
const THIRTY_DAYS_MS = 30 * 86_400_000;

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit);
}

function requestPath(request) {
  try {
    return cleanText(new URL(request.url, "http://origin.invalid").pathname, 2048) || "/";
  } catch {
    return "/";
  }
}

function remoteIp(request) {
  return cleanText(request.socket?.remoteAddress || "", 128);
}

export class AccessLogger {
  constructor(directory, { now = () => new Date() } = {}) {
    this.directory = directory;
    this.now = now;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o750 });
    await this.compressOld();
    return this;
  }

  observe(request, response) {
    const startedAt = this.now();
    const startedNs = process.hrtime.bigint();
    let bytes = 0;
    let completed = false;
    const originalWrite = response.write;
    const originalEnd = response.end;
    response.write = function (chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) bytes += Buffer.byteLength(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    response.end = function (chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) bytes += Buffer.byteLength(chunk, encoding);
      return originalEnd.call(this, chunk, encoding, callback);
    };
    const finish = () => {
      if (completed) return;
      completed = true;
      const elapsed = Number(process.hrtime.bigint() - startedNs) / 1e6;
      this.write({
        timestamp: startedAt.toISOString(),
        method: cleanText(request.method, 32),
        path: requestPath(request),
        status: response.statusCode,
        bytes,
        duration_ms: Math.round(elapsed * 1000) / 1000,
        remote_ip: remoteIp(request),
        user_agent: cleanText(request.headers["user-agent"], 512),
      }).catch((error) => console.error("access log write failed", error));
    };
    response.once("finish", finish);
    response.once("close", finish);
  }

  write(record) {
    if (this.closed) return Promise.reject(new Error("access logger is closed"));
    const operation = this.queue.catch(() => {}).then(async () => {
      const date = record.timestamp.slice(0, 10);
      const filename = path.join(this.directory, `access-${date}.log`);
      await appendFile(filename, `${JSON.stringify(record)}\n`, { mode: 0o640 });
    });
    this.queue = operation;
    return operation;
  }

  compressOld(now = this.now()) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString().slice(0, 10);
      const entries = await readdir(this.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = LOG_PATTERN.exec(entry.name);
        if (!match || match[1] >= cutoff) continue;
        const source = path.join(this.directory, entry.name);
        const destination = `${source}.gz`;
        try {
          const existing = await stat(destination);
          if (existing.isFile()) {
            await rm(source);
            continue;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await gzipAtomic(source, destination);
        await rm(source);
      }
    });
    this.queue = operation;
    return operation;
  }

  async close() {
    this.closed = true;
    await this.queue;
  }
}

async function gzipAtomic(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await pipeline(
      createReadStream(source),
      createGzip(),
      createWriteStream(temporary, { flags: "wx", mode: 0o640 }),
    );
    const handle = await open(temporary, "r");
    try {
      await syncFile(handle);
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncFile(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") return;
    throw error;
  }
}
