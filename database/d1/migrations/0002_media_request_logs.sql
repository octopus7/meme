CREATE TABLE media_request_logs (
  id INTEGER PRIMARY KEY,
  requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
  blob_hash TEXT NOT NULL
    CHECK (length(blob_hash) = 64 AND blob_hash NOT GLOB '*[^0-9a-f]*'),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('original', 'thumbnail')),
  request_method TEXT NOT NULL CHECK (request_method IN ('GET', 'HEAD')),
  cache_status TEXT NOT NULL CHECK (length(cache_status) BETWEEN 1 AND 32),
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  colo TEXT CHECK (colo IS NULL OR length(colo) = 3)
);

CREATE INDEX media_request_logs_time
  ON media_request_logs(requested_at DESC, id DESC);

CREATE INDEX media_request_logs_blob_time
  ON media_request_logs(blob_hash, requested_at DESC);
