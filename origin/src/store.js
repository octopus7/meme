import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename as fsRename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

export const STORE_ERRORS = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  TRASHED: "TRASHED",
  CONFLICT: "CONFLICT",
  TOO_LARGE: "TOO_LARGE",
  UNSUPPORTED: "UNSUPPORTED",
});

const FORMATS = Object.freeze({
  jpeg: { extension: "jpg", mime: "image/jpeg" },
  png: { extension: "png", mime: "image/png" },
  webp: { extension: "webp", mime: "image/webp" },
  gif: { extension: "gif", mime: "image/gif" },
});
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EXTENSIONS = new Set(Object.values(FORMATS).map((value) => value.extension));

function storeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async run(task) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(task) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class ImageStore {
  constructor(config, { now = () => new Date() } = {}) {
    this.root = config.dataDir;
    this.maxUploadBytes = config.maxUploadBytes;
    this.maxImagePixels = config.maxImagePixels;
    this.trashRetentionMs = config.trashRetentionMs;
    this.now = now;
    this.stateMutex = new Mutex();
    this.imageSemaphore = new Semaphore(config.imageConcurrency);
    this.imagesDir = path.join(this.root, "images");
    this.thumbnailsDir = path.join(this.root, "thumbnails");
    this.trashImagesDir = path.join(this.root, "trash", "images");
    this.trashThumbnailsDir = path.join(this.root, "trash", "thumbnails");
    this.trashRecordsDir = path.join(this.root, "trash", "records");
    this.tempDir = path.join(this.root, "tmp");
  }

  async init() {
    await Promise.all([
      this.imagesDir,
      this.thumbnailsDir,
      this.trashImagesDir,
      this.trashThumbnailsDir,
      this.trashRecordsDir,
      this.tempDir,
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o750 })));
    return this;
  }

  validateHash(hash) {
    if (!HASH_PATTERN.test(hash)) throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
  }

  originalPath(hash, extension) {
    this.validateHash(hash);
    if (!EXTENSIONS.has(extension)) throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
    return path.join(this.imagesDir, `${hash}.${extension}`);
  }

  thumbnailPath(hash) {
    this.validateHash(hash);
    return path.join(this.thumbnailsDir, `${hash}.webp`);
  }

  trashRecordPath(hash) {
    this.validateHash(hash);
    return path.join(this.trashRecordsDir, `${hash}.json`);
  }

  async isTrashed(hash) {
    return exists(this.trashRecordPath(hash));
  }

  async findActiveOriginal(hash) {
    this.validateHash(hash);
    const matches = [];
    for (const extension of EXTENSIONS) {
      const filename = path.join(this.imagesDir, `${hash}.${extension}`);
      if (await exists(filename)) matches.push({ filename, extension });
    }
    if (matches.length === 0) throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
    if (matches.length !== 1) throw storeError(STORE_ERRORS.CONFLICT, "blob state conflict");
    return matches[0];
  }

  async put(readable) {
    return this.imageSemaphore.run(async () => {
      const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const rawTemp = path.join(this.tempDir, `.upload-${suffix}`);
      const thumbTemp = path.join(this.tempDir, `.thumbnail-${suffix}.webp`);
      try {
        const { hash, size } = await streamAndHash(readable, rawTemp, this.maxUploadBytes);
        let metadata;
        try {
          metadata = await sharp(rawTemp, {
            animated: false,
            failOn: "error",
            limitInputPixels: this.maxImagePixels,
          }).metadata();
        } catch (error) {
          throw storeError(STORE_ERRORS.UNSUPPORTED, "invalid or unsupported image", error);
        }
        const format = FORMATS[metadata.format];
        if (!format) throw storeError(STORE_ERRORS.UNSUPPORTED, "unsupported image format");
        try {
          await sharp(rawTemp, {
            animated: false,
            failOn: "error",
            limitInputPixels: this.maxImagePixels,
          })
            .rotate()
            .resize(128, 128, { fit: "cover", position: "centre" })
            .webp({ quality: 82 })
            .toFile(thumbTemp);
        } catch (error) {
          throw storeError(STORE_ERRORS.UNSUPPORTED, "image decode failed", error);
        }
        return await this.stateMutex.run(async () => {
          if (await this.isTrashed(hash)) {
            throw storeError(STORE_ERRORS.TRASHED, "blob is in trash");
          }
          try {
            const existing = await this.findActiveOriginal(hash);
            const info = await stat(existing.filename);
            if (existing.extension !== format.extension || info.size !== size) {
              throw storeError(STORE_ERRORS.CONFLICT, "blob state conflict");
            }
            const thumbnail = this.thumbnailPath(hash);
            if (!(await exists(thumbnail))) await renameFile(thumbTemp, thumbnail);
            return { hash, extension: format.extension, mimeType: format.mime, size, deduplicated: true };
          } catch (error) {
            if (error.code !== STORE_ERRORS.NOT_FOUND) throw error;
          }
          const original = this.originalPath(hash, format.extension);
          const thumbnail = this.thumbnailPath(hash);
          await renameFile(rawTemp, original);
          try {
            await renameFile(thumbTemp, thumbnail);
          } catch (error) {
            await rm(original, { force: true });
            throw error;
          }
          return { hash, extension: format.extension, mimeType: format.mime, size, deduplicated: false };
        });
      } finally {
        await Promise.all([
          rm(rawTemp, { force: true }),
          rm(thumbTemp, { force: true }),
        ]);
      }
    });
  }

  async resolveOriginal(hash, extension) {
    if (await this.isTrashed(hash)) throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
    const filename = this.originalPath(hash, extension);
    try {
      return { filename, info: await stat(filename) };
    } catch (error) {
      if (error.code === "ENOENT") throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
      throw error;
    }
  }

  async resolveThumbnail(hash) {
    if (await this.isTrashed(hash)) throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
    const filename = this.thumbnailPath(hash);
    try {
      return { filename, info: await stat(filename) };
    } catch (error) {
      if (error.code === "ENOENT") throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
      throw error;
    }
  }

  async trash(hash) {
    return this.stateMutex.run(async () => {
      if (await this.isTrashed(hash)) return this.readTrashRecord(hash);
      const original = await this.findActiveOriginal(hash);
      const thumbnail = this.thumbnailPath(hash);
      if (!(await exists(thumbnail))) throw storeError(STORE_ERRORS.CONFLICT, "thumbnail missing");
      const now = this.now();
      const record = {
        hash,
        extension: original.extension,
        trashed_at: now.toISOString(),
        purge_at: new Date(now.getTime() + this.trashRetentionMs).toISOString(),
      };
      const trashOriginal = path.join(this.trashImagesDir, `${hash}.${original.extension}`);
      const trashThumbnail = path.join(this.trashThumbnailsDir, `${hash}.webp`);
      await renameFile(original.filename, trashOriginal);
      try {
        await renameFile(thumbnail, trashThumbnail);
        await atomicJson(this.trashRecordPath(hash), record);
      } catch (error) {
        await renameFile(trashThumbnail, thumbnail).catch(() => {});
        await renameFile(trashOriginal, original.filename).catch(() => {});
        throw error;
      }
      return record;
    });
  }

  async readTrashRecord(hash) {
    try {
      const record = JSON.parse(await readFile(this.trashRecordPath(hash), "utf8"));
      if (record.hash !== hash || !EXTENSIONS.has(record.extension) || !record.purge_at) {
        throw storeError(STORE_ERRORS.CONFLICT, "invalid trash record");
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") throw storeError(STORE_ERRORS.NOT_FOUND, "not found");
      throw error;
    }
  }

  async restore(hash) {
    return this.stateMutex.run(async () => {
      const record = await this.readTrashRecord(hash);
      const original = this.originalPath(hash, record.extension);
      const thumbnail = this.thumbnailPath(hash);
      if (await exists(original) || await exists(thumbnail)) {
        throw storeError(STORE_ERRORS.CONFLICT, "active destination exists");
      }
      const trashOriginal = path.join(this.trashImagesDir, `${hash}.${record.extension}`);
      const trashThumbnail = path.join(this.trashThumbnailsDir, `${hash}.webp`);
      await renameFile(trashOriginal, original);
      try {
        await renameFile(trashThumbnail, thumbnail);
        await rm(this.trashRecordPath(hash));
      } catch (error) {
        await renameFile(thumbnail, trashThumbnail).catch(() => {});
        await renameFile(original, trashOriginal).catch(() => {});
        throw error;
      }
      return record;
    });
  }

  async purgeExpired() {
    return this.stateMutex.run(async () => {
      const entries = await readdir(this.trashRecordsDir, { withFileTypes: true });
      let purged = 0;
      const failures = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const hash = entry.name.slice(0, 64);
        try {
          const record = await this.readTrashRecord(hash);
          if (Date.parse(record.purge_at) > this.now().getTime()) continue;
          await rm(path.join(this.trashImagesDir, `${hash}.${record.extension}`), { force: true });
          await rm(path.join(this.trashThumbnailsDir, `${hash}.webp`), { force: true });
          await rm(this.trashRecordPath(hash), { force: true });
          purged += 1;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, `purge incomplete; ${purged} removed`);
      return purged;
    });
  }
}

async function streamAndHash(readable, destination, limit) {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        callback(storeError(STORE_ERRORS.TOO_LARGE, `upload exceeds ${limit} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(readable, meter, createWriteStream(destination, { flags: "wx", mode: 0o640 }));
  const handle = await open(destination, "r");
  try {
    await syncFile(handle);
  } finally {
    await handle.close();
  }
  return { hash: hash.digest("hex"), size };
}

async function atomicJson(destination, value) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o640 });
    const handle = await open(temporary, "r");
    try {
      await syncFile(handle);
    } finally {
      await handle.close();
    }
    await renameFile(temporary, destination);
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

async function renameFile(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsRename(source, destination);
      return;
    } catch (error) {
      const retryable = process.platform === "win32"
        && (error.code === "EBUSY" || error.code === "EPERM")
        && attempt < 10;
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
