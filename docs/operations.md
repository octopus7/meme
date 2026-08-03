# Cache, Deletion, and Recovery

[한국어](operations.KO.md) | **English**

## Runtime and containers

The Node origin uses a Debian Bookworm-based Node.js 24 LTS container managed by
Synology Container Manager. Regularly rebuild the `node:24-bookworm-slim` image
so security updates are applied.

- Bind only `127.0.0.1:8086` on the host and do not expose it through the router.
- Back up `.env`, `data/`, and `logs/` separately from the container image.
- Verify that the read-only filesystem, dropped capabilities, and
  `no-new-privileges` remain enabled.
- Monitor Container Manager health and restart counts.
- Monitor the Cloudflare Tunnel connector state together with published hostname
  and Cache Rule changes.

## Request paths and CDN cache

Image URLs are determined by the SHA-256 of the file contents, so active content
is immutable.

```text
GET /i/<hash>.<ext>  original
GET /t/<hash>        centered square crop, 128×128 WebP
```

Image GET requests do not pass through the storage Worker.

```text
Browser → img.example.com → Cloudflare CDN
                              ├─ HIT: respond at the edge
                              └─ MISS: Tunnel → Synology origin
```

In the Cloudflare Cache Rule, explicitly set `/i/*` and `/t/*` as cache eligible,
and remove query strings from the cache key or reject them on public paths. Do not
cache methods other than GET/HEAD or 404/5xx responses. Because `/t/{hash}` has no
extension, include it separately in the rule.

Normal responses allow the browser to use a one-year immutable cache and send the
same blob tag.

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Tag: blob-<sha256>
```

Browser local caches cannot be deleted by a Cloudflare purge. If the policy allows
local caches to remain, leave them as they are; judge access control for new network
requests from the Cloudflare edge cache and origin state. Cloudflare Cache Analytics
and Synology origin access logs show overall CDN behavior, but the former per-file
D1 HIT/MISS logs from the storage Worker are no longer generated.

## Image URL exposure logs

The web Worker records a best-effort entry in D1's `image_url_exposure_logs` only
when it includes an image URL in the `/all` or `/search` HTML.

Recorded fields:

```text
exposed_at, image_item_id, blob_hash, original_filename,
byte_size, exposure_context, viewer_sub
```

This does not indicate whether the browser actually requested the image, read it from
the local cache, received a Cloudflare HIT, or connected through the Tunnel. A log
write failure must not fail list or search responses. Administrators query
`/exposures` by period and cursor, while the web Worker's 10-minute cron removes rows
older than 90 days in bounded batches.

## Reference deletion and edge purge

When a user deletes an item, remove only that user's logical reference. If other
references remain, keep the physical file and public URL. When the last reference is
gone, follow this order:

```text
D1: trash_pending
→ origin-admin: atomically move from active to trash
→ Cloudflare Zone purge_cache(tags=[blob-<hash>])
→ D1: trashed, purge_after = trashed_at + 30 days
```

The web Worker sends an HTTPS request to `origin-admin.example.com` and authenticates
with the origin Bearer token.

```http
Authorization: Bearer <origin mutation token>
```

The short non-atomic interval between the origin move and edge purge is acceptable.
If the purge fails, keep `trash_pending` and let the web Worker cron retry. Do not
finalize as `trashed` before both stages finish, and implement the operation
idempotently.

Immediately after deletion, behavior is as follows:

```text
Cloudflare edge cache remains → existing image responses may work until purge
tag purge completes → new requests are edge MISS → origin returns 404
Browser local cache → may remain visible on screens of users who already visited
```

Do not cache 404s or origin errors for a long period.

## Administrator recovery

Limit administrative procedures to an auditable administrator UI or direct operational
commands.

1. Check the hash, existing references, and `purge_after` in D1.
2. Verify that both the original and thumbnail exist in origin trash and that their
   hashes match.
3. Have the administrator specify the user reference and explanation to restore.
4. Move the origin files to active and restore the D1 state and references in a
   transaction.
5. If necessary, purge `blob-<hash>` again and verify that the image is served by a
   new network request.

Do not perform a partial recovery by moving only the files to active or changing only
the D1 state. Files that have become `purged` after 30 days cannot be recovered from
the service and are subject to a separate backup policy.

## Expiration and failures

The origin scheduled job checks the expiration time of trash records and deletes the
original, thumbnail, and record. D1 `trashed` rows remain as audit records permanently
excluded from user searches. If origin deletion fails, preserve the record and retry
on the next cycle.

Observe:

- Overall HIT/MISS and Tunnel/origin request counts in Cloudflare Cache Analytics
- Cache purge failures and long-lived `trash_pending` entries
- Origin Bearer token authentication failures and blocked requests to the public
  image hostname
- Free origin disk space and trash size
- `trashed` entries that remain after 30 days
- Image URL exposure-log retention work and D1 errors
- Hash/MIME/extension mismatches and the number of quarantined corrupt files
