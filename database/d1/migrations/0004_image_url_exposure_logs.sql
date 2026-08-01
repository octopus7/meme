CREATE TABLE image_url_exposure_logs (
  id INTEGER PRIMARY KEY,
  exposed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  image_item_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL
    CHECK (length(blob_hash) = 64 AND blob_hash NOT GLOB '*[^0-9a-f]*'),
  original_filename TEXT NOT NULL CHECK (length(original_filename) <= 255),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  exposure_context TEXT NOT NULL CHECK (exposure_context IN ('all', 'search')),
  viewer_sub TEXT NOT NULL
);

CREATE INDEX image_url_exposure_logs_time
  ON image_url_exposure_logs(exposed_at DESC, id DESC);

CREATE INDEX image_url_exposure_logs_blob_time
  ON image_url_exposure_logs(blob_hash, exposed_at DESC);

CREATE INDEX image_url_exposure_logs_viewer_time
  ON image_url_exposure_logs(viewer_sub, exposed_at DESC, id DESC);
