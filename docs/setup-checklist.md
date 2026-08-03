# Operations Setup Checklist

[한국어](setup-checklist.KO.md) | **English**

Do not record real IDs, domains, email addresses, or tokens in the repository.
Installers who found the VPC configuration in the previous Reddit post should refer
to the [v1-vpc-final release](https://github.com/octopus7/meme/releases/tag/v1-vpc-final);
the checklist below applies to the current direct Tunnel architecture.

## 1. Origin installation

- [ ] Install Node origin on `8086`
- [ ] Install it at `/volume1/docker/meme-origin`
- [ ] Verify the Container Manager project and health status
- [ ] Verify that local `/healthz` succeeds
- [ ] Create the origin mutation token and verify its backup policy
- [ ] Verify that the router has no port forwarding

## 2. Tunnel and CDN

- [ ] Create a Cloudflare Tunnel and install `cloudflared` on Synology
- [ ] Create a published route from `img.example.com` to Node origin `8086`
- [ ] Create a published route from `origin-admin.example.com` to the same origin
- [ ] Set the origin mutation Bearer token identically in the web Worker and Synology
- [ ] Allow only GET/HEAD for `/i/*` and `/t/*` on `img.example.com`
- [ ] Block `img.example.com/internal/*`, `/healthz`, and all write methods
- [ ] Create a Cache Rule for `/i/*` and `/t/*` (including extensionless `/t/{hash}`)
- [ ] Verify one-year edge TTL for 200/206, no caching for 404/5xx, and the query-key policy
- [ ] Create a Zone cache purge API token with minimum tag-purge permissions
- [ ] Verify `Cache-Tag: blob-<sha256>` in image origin responses

Workers VPC, VPC Service ID, `Connectivity Directory Bind`, and the storage Worker
are not required by the current architecture.

## 3. GitHub Environments

### `web-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `WEB_WORKER_NAME`
- [ ] `D1_DATABASE_NAME`
- [ ] `D1_DATABASE_ID`
- [ ] `IMAGE_ORIGIN=https://<IMAGE_DOMAIN>`
- [ ] `ORIGIN_ADMIN_BASE_URL=https://<ORIGIN_ADMIN_DOMAIN>`
- [ ] `CF_ZONE_ID`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_REDIRECT_URI=https://<APP_DOMAIN>/auth/callback`
- [ ] `GOOGLE_ALLOWED_EMAILS=<one administrator email>`

Cloudflare web Worker encrypted secrets:

- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `AUTH_SESSION_SECRET`
- [ ] `ORIGIN_ADMIN_TOKEN` (same as the origin mutation token)
- [ ] `CF_CACHE_PURGE_TOKEN`

### `d1-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `D1_DATABASE_NAME`
- [ ] `D1_DATABASE_ID`

Do not create `storage-production`, `STORAGE_WORKER_NAME`, `VPC_SERVICE_ID`, or
`ORIGIN_BASE_URL` for a new deployment.

## 4. Deployment and feature checks

- [ ] Run `Migrate D1` (including `image_url_exposure_logs`)
- [ ] Run `Deploy web Worker`
- [ ] Connect the `app.example.com` Custom Domain to the web Worker
- [ ] Verify that the Tunnel route and Cache Rule remain after deployment
- [ ] Verify that an unauthenticated browser is redirected to the Google sign-in screen
- [ ] Verify that list, search, and upload work with an administrator account
- [ ] Verify that image URLs in `/all` and `/search` point to `img.example.com`
- [ ] Verify that exposure records contain the time, filename, size, screen, and viewer sub
- [ ] Verify unauthenticated GET/HEAD behavior for `img.example.com/i/...` and `/t/...`
- [ ] Verify `Cf-Cache-Status: HIT` on the second request
- [ ] Verify that `img.example.com/internal/*` is blocked and the `origin-admin` mutation token is validated
- [ ] Verify the last-reference deletion order: origin trash move → cache-tag purge → D1 finalization
- [ ] Verify that a new network request returns 404 after purge (the browser local cache may remain)
- [ ] Verify period queries and cursor pagination on the administrator `/exposures` screen
- [ ] Verify that regular members cannot see the administrator screen or exposure records

## 5. Failure and operations tests

- [ ] Verify that the management API rejects missing or invalid origin mutation tokens
- [ ] Verify that upload and deletion are rejected when origin mutation tokens do not match
- [ ] Verify that a failed Cloudflare purge remains `trash_pending` and is retried by cron
- [ ] Verify that image and list responses do not fail during a D1 outage
- [ ] Validate Tunnel interruption, low disk space, and the 30-day purge with separate test data
