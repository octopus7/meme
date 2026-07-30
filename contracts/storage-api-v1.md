# Storage worker internal contract v1

The web Worker binds to the storage Worker's named `Admin` entrypoint. This
entrypoint is not publicly routed.

## Upload

`POST https://storage.internal/internal/v1/blobs`

- Body: raw image bytes.
- `Content-Type`: browser-reported image type (advisory only).
- The user-facing Worker keeps `filename` and `description` in D1. They are not
  required by the origin, which validates the file independently.

Successful response:

```json
{
  "hash": "64 lowercase hexadecimal characters",
  "extension": "jpg",
  "mimeType": "image/jpeg",
  "size": 12345,
  "deduplicated": false
}
```

## Move an unreferenced blob to trash

`POST https://storage.internal/internal/v1/blobs/{sha256}/trash`

The call is idempotent. The storage Worker first makes the origin unavailable,
then purges both `/i/...` and `/t/...` using cache tag `blob-{sha256}`.

## Health

`GET https://storage.internal/internal/v1/healthz`

The public default entrypoint exposes only `GET` and `HEAD` for canonical
`/i/{sha256}.{extension}` and `/t/{sha256}` paths.
