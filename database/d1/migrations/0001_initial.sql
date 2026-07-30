PRAGMA foreign_keys = ON;

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY
    CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  extension TEXT NOT NULL CHECK (extension IN ('jpg', 'png', 'webp', 'gif')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'trash_pending', 'trashed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  trashed_at TEXT,
  purge_after TEXT
);

CREATE TABLE image_items (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  description TEXT NOT NULL CHECK (length(description) <= 500),
  original_filename TEXT NOT NULL CHECK (length(original_filename) <= 255),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(owner_sub, blob_hash)
);

CREATE INDEX image_items_owner_order
  ON image_items(owner_sub, created_at DESC, id DESC);

CREATE INDEX image_items_blob
  ON image_items(blob_hash);
