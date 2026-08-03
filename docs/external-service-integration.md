# Using the `meme` Image Store from a Worker+D1 Service
[한국어](external-service-integration.KO.md) | **English**

This document is an integration specification intended to be handed to an agent implementing a new service on its own.
The new service separates Cloudflare Pages and a Worker, and connects a D1 dedicated to the new service to the Worker.
`meme` handles only image-file uploads and public URL serving.

## Confirmed Responsibilities

### New service

- Cloudflare Pages: provides static HTML, CSS, and JavaScript
- Cloudflare Worker: provides the application API and calls the `meme` upload endpoint
- New service D1: stores image descriptions, ownership relationships, post relationships, search data, and the image addresses returned by `meme`
- User login and authorization: handled by the new service itself when needed

### meme

- Allows image uploads from servers holding a valid upload token
- Returns public URLs for the original and preview as the upload result
- Serves images via `GET`/`HEAD` at the returned URLs
- When the Cloudflare CDN has a cache MISS, serves the image from the origin through the Tunnel

### Features not provided by `meme`

- User login or user-account linking
- Image listing
- Image search
- Post or application-metadata management
- Direct connection to the new service's D1
- An image-deletion API in this integration specification

The party that uploads an image stores its address and metadata in its own D1 and implements listing and search directly.
Do not add a listing or search endpoint to `meme`.

## Overall Architecture

```text
Browser
├─ Static screens ─────────────→ Cloudflare Pages
├─ App API/upload ─────────────→ New service Worker ─→ New service D1
│                                    │
│                                    └─ Upload token ─→ meme upload endpoint
└─ Public image GET/HEAD ─────→ meme image domain ─→ Cloudflare CDN
                                                          │ cache MISS
                                                          ▼
                                                    Tunnel → origin
```

Pages does not call `meme` directly. The new service Worker attaches the upload token and
sends a server-to-server request, then passes only the public image URL received as the upload result to the browser.

## Authentication Principles

Image-upload authorization is determined only by the `meme` upload token, independently of user login.

- Do not send the new service login token, Google OAuth, or session cookie to `meme`.
- The `meme` upload token is a credential for the single new service Worker.
- `meme` does not need to know whether the user is logged in to the new service.
- The new service Worker independently decides who may use the upload feature in the new service.
- Image retrieval requires neither login nor a token.

The new service Worker sends the following header on `meme` upload requests.

```http
Authorization: Bearer <meme upload token>
```

Use a cryptographically secure random value of at least 32 bytes for the token. Register it as
`MEME_UPLOAD_TOKEN` in the new service Worker's encrypted secret, and do not put it in Pages environment variables,
static JavaScript, D1, the Git repository, or logs.

Do not reuse or share the existing `meme` Google session secret, `ORIGIN_ADMIN_TOKEN`, cache purge token, or
Tunnel token as the upload token with the new service. `meme` must have a separate **upload-only token** made
specifically for this service.

## Prerequisite Implementation

The current `meme` browser upload API assumes a Google session and same-origin requests. The existing
`/internal/v1/blobs` on the origin is protected by an admin token and is also used for deletion and restoration.
The new service must not use either directly.

Therefore, first add an integration endpoint to `meme` with the following characteristics.

```text
POST https://<MEME_UPLOAD_HOST>/v1/images
```

This endpoint must satisfy the following conditions.

- Allow only a separate token corresponding to `MEME_UPLOAD_TOKEN`
- Grant no origin-administration permissions beyond uploading
- Stream the request body through the origin storage logic
- Return the completed public image URL as JSON on success
- Do not create listing, search, user-lookup, or deletion endpoints

This path is the target contract. Do not consider the integration complete until the endpoint and dedicated-token
validation are implemented in the actual deployment and pass an invocation test.

## Upload API Contract

The request body is raw image bytes, not multipart.

```http
POST /v1/images HTTP/1.1
Authorization: Bearer <meme upload token>
Content-Type: image/png
Content-Length: 12345
Idempotency-Key: <unique value>
X-Original-Filename: example.png

<raw image bytes>
```

If `X-Original-Filename` contains non-ASCII characters, send its `encodeURIComponent` value and decode it exactly
once in `meme`. Do not send image descriptions, tags, or post information to `meme`; store them in the new service D1.

The `meme` upload endpoint validates the following.

- `Authorization: Bearer` token
- Whether `Content-Length` exists and the maximum upload byte count
- The actual file format: JPEG, PNG, WebP, or GIF
- Maximum pixel count
- Original filename length
- Per-token rate limiting and upload concurrency
- Duplicate requests for the same token and `Idempotency-Key` combination

Recommended success response:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Cache-Control: private, no-store
```

```json
{
  "hash": "<sha256>",
  "extension": "png",
  "mime_type": "image/png",
  "byte_size": 12345,
  "original_url": "https://img.example.com/i/<sha256>.png",
  "thumbnail_url": "https://img.example.com/t/<sha256>"
}
```

The new service must store the response values as-is rather than constructing `original_url` and `thumbnail_url` directly.

Recommended error responses:

| Status | Meaning | New service handling |
|---|---|---|
| `400` | Image format or request-metadata error | Show the error to the user; do not retry |
| `401` | Token missing or does not match | Record as an operational error; verify the token |
| `413` | Allowed size exceeded | Show the size limit to the user |
| `429` | Rate limit exceeded | Respect `Retry-After` and retry within the limit |
| `5xx` | Temporary storage or Tunnel failure | Retry with bounded exponential backoff |

Error JSON must not include detailed internal paths, tokens, or origin-administration information.

## New Service Worker Implementation

Stream the image body received by Pages to `meme` as much as possible instead of buffering it in full.

New service Worker environment settings:

```text
MEME_UPLOAD_BASE_URL=https://<MEME_UPLOAD_HOST>   general setting
MEME_IMAGE_ORIGIN=https://<MEME_IMAGE_HOST>      general setting
MEME_UPLOAD_TOKEN=<secret>                       encrypted secret
```

Processing order:

```text
Pages upload request
→ New service Worker's own request validation
→ Generate a unique Idempotency-Key
→ Stream the body to the meme upload endpoint
→ Validate the URLs and hash in the meme response
→ Store application data and URLs in the new service D1
→ Return only the result needed by Pages
```

Before trusting the `meme` response, the new service Worker verifies the following.

- `hash` is a 64-character lowercase hexadecimal string
- `extension` is in the allowed list
- Both URLs use HTTPS and the exact image hostname configured by the operator
- The original path is `/i/<hash>.<extension>`
- The preview path is `/t/<hash>`
- The URLs have no query or fragment

## New Service D1 Storage

Do not store image-file bytes in D1. In application tables, store at least the following values along with the required relationship data.

```text
meme_hash
meme_original_url
meme_thumbnail_url
meme_mime_type
meme_byte_size
created_at
```

The filename, description, tags, uploader, and post relationships all belong to the new service's data.
Implement listing and search using only this D1. Do not bind or query the `meme` D1.

The upload is split between `meme` file storage and the new service D1 write, so it is not one transaction.

1. If the `meme` upload fails, do not commit the new service D1 record.
2. If the `meme` upload succeeds but the D1 write fails, retry with the same `Idempotency-Key` to receive the same upload result.
3. The request ID and hash may be kept in structured logs, but do not log the token or image body.

## Public Image Serving

Public image URL formats:

| Type | URL |
|---|---|
| Original | `https://<MEME_IMAGE_HOST>/i/<sha256>.<ext>` |
| 128×128 WebP preview | `https://<MEME_IMAGE_HOST>/t/<sha256>` |

Allow only `GET` and `HEAD` for retrieval, and do not require authentication. Anyone who obtains a URL can view
the image. Do not treat URLs as secret links or access-control mechanisms, and do not store sensitive images.

The browser uses the returned image URL directly in `<img>` without going through the new service Worker. When the
Cloudflare CDN has a cache HIT, the request does not reach the Tunnel or origin.

Successful image responses may be cached as immutable for a long period.

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Tag: blob-<sha256>
Cross-Origin-Resource-Policy: cross-origin
```

Ordinary `<img src="...">` display works without CORS. Having browser JavaScript read the image body or canvas
pixels is outside the scope of this specification and may require separate CORS.

## Separating Pages and the Worker

If Pages and the new service Worker have different origins, the new service Worker allows CORS only for the exact
Pages origin. Do not open the `meme` upload endpoint to browser CORS.

- Pages calls only the new service Worker.
- Only the new service Worker holds `MEME_UPLOAD_TOKEN`.
- Minimize the allowed Pages origins, methods, and request headers.
- Handle the required `OPTIONS` preflight in the new service Worker.
- Do not put `MEME_UPLOAD_TOKEN` in the Pages bundle, responses, error bodies, or browser requests.

## Retention Policy

This integration provides only uploading and public serving. Because there is no deletion API, uploaded files
remain until the operator's separate retention policy applies. If deletion becomes necessary later, design it with
permissions separate from the upload token and a separate contract; do not add arbitrary deletion calls to this document.

## Prohibited Actions

- Do not automate the existing browser API with a Google session cookie.
- Do not share the existing `ORIGIN_ADMIN_TOKEN` with the new service.
- Do not call the origin's `/internal/*` administration API directly.
- Do not scrape `/all` or `/api/search`.
- Do not read the `meme` D1 directly from the new service Worker.
- Do not pass the upload token to Pages or the browser.
- Do not use public image URLs as authentication or authorization checks.

## Implementation Checklist

### meme

- [ ] Issue an upload token dedicated to the new service
- [ ] Implement the upload-only `POST /v1/images`
- [ ] Separate the permissions of the existing admin token and the upload token
- [ ] Implement raw-body streaming and format, size, and pixel validation
- [ ] Implement idempotency and per-token rate limiting
- [ ] Return completed public URLs for the original and preview
- [ ] Allow only `GET`/`HEAD` on the public image hostname
- [ ] Test missing/invalid tokens, oversized files, duplicate requests, and origin failures

### New service Worker+D1

- [ ] Bind a D1 dedicated to the new service to the Worker
- [ ] Register `MEME_UPLOAD_TOKEN` as a Worker encrypted secret
- [ ] Receive Pages uploads and stream them to `meme`
- [ ] Validate the response hash, extension, and hostname
- [ ] Store the returned URLs and application metadata in the new service D1
- [ ] Use only the new service D1 for search and listing
- [ ] Implement CORS allowing only the exact Pages origin
- [ ] Use the same `Idempotency-Key` on retries
- [ ] Verify that tokens and image bodies do not appear in logs

### Pages

- [ ] Deploy only static assets and do not include the upload token
- [ ] Call only the new service Worker for uploads
- [ ] Display images directly using the returned public URLs

## Completion Criteria

1. An image upload with a valid dedicated token succeeds and returns two public URLs.
2. An upload with a missing or incorrect token returns `401`.
3. The public URL for the same file opens with `GET`/`HEAD` without login or a token.
4. The upload token is absent from the Pages bundle and browser network requests.
5. Whether the user is logged in to the new service does not affect `meme` upload authorization or image retrieval.
6. The URLs and application metadata are stored in the new service D1, and listing and search run only against that D1.
7. The new service does not use the existing `meme` D1, Google session, or origin-administration APIs.
