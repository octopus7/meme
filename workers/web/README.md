# Google-Authenticated Web Worker

[한국어](README.KO.md) | **English**

This directory is deployed independently. Do not store the Cloudflare account ID,
D1 ID, hostnames, or API token here.

## Generate configuration

CI provides the following values through GitHub Environment variables and then runs
`.github/scripts/render-web-wrangler.mjs`. The generated `.wrangler.generated.jsonc`
and Worker type files are ignored by Git.

- `WEB_WORKER_NAME`
- `IMAGE_ORIGIN`
- `ORIGIN_ADMIN_BASE_URL`
- `CF_ZONE_ID`
- `D1_DATABASE_NAME`
- `D1_DATABASE_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_ALLOWED_EMAILS`

Manage `CLOUDFLARE_API_TOKEN` as a GitHub Environment secret and `CF_ACCOUNT_ID` as
an Environment variable. Register the following values directly as Cloudflare
encrypted secrets for the web Worker.

- `GOOGLE_CLIENT_SECRET`
- `AUTH_SESSION_SECRET`
- `ORIGIN_ADMIN_TOKEN`
- `CF_CACHE_PURGE_TOKEN`

`ORIGIN_ADMIN_TOKEN` must match the origin's `MEME_ORIGIN_MUTATION_TOKEN`. Management
requests to `origin-admin.example.com` authenticate with this bearer token, while the
purge token permits only cache-tag purges for the image Zone. See
`docs/cloudflare.md` and `docs/google-oauth.md` for detailed issuance and URL setup.

## Runtime responsibilities

The web Worker does not handle image retrieval.

```text
List/search HTML
  web Worker → include IMAGE_ORIGIN URL → D1 exposure log

Image GET
  Browser → Cloudflare CDN → Tunnel → Synology origin (only on cache MISS)
```

`IMAGE_ORIGIN` must be a public image CDN hostname such as
`https://img.example.com`. The web Worker cannot tell whether the browser actually
requested this URL, read it from the local cache, or received a CDN HIT.

Management requests such as upload, deletion, and recovery use a direct HTTPS fetch
to `ORIGIN_ADMIN_BASE_URL`. The web Worker sends this header:

```http
Authorization: Bearer <origin mutation token>
```

Do not use a separate image Worker service binding or Workers VPC binding. Uploads
forward the original image stream to the origin's `POST /internal/v1/blobs`, and
deletion of the last reference follows this order:

```text
D1 trash_pending
→ POST /internal/v1/blobs/:sha256/trash
→ Cloudflare Zone cache-tag purge(blob-<sha256>)
→ D1 trashed
```

If the purge fails, leave the item as `trash_pending` for cron to retry. Do not
finalize the deletion before the origin operation and purge are complete.

When `/all` and `/search` include image URLs in HTML, record the following information
in `image_url_exposure_logs` on a best-effort basis.

```text
exposed_at, image_item_id, blob_hash, original_filename,
byte_size, exposure_context, viewer_sub
```

This record is the time of URL exposure, not a download, request, or cache HIT. The
administrator screen provides period queries and cursor pagination at `/exposures`,
and a 10-minute cron cleans up rows older than 90 days in bounded batches. A logging
failure does not block the user page response.

## Local checks

Generate the configuration file with test Environment variables, then run:

```sh
node ../../.github/scripts/render-web-wrangler.mjs .wrangler.generated.jsonc
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --config .wrangler.generated.jsonc --dry-run
```

Delete the generated `.wrangler.generated.jsonc` and
`src/worker-configuration.d.ts` after checking. Do not record real secrets in local
files or command lines.

The upload body is the original image stream, not multipart. The browser sends the
description and original filename in URL-encoded request headers, so the Worker can
forward the image to the origin management hostname without buffering the entire
image.
