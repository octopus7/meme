# meme

[한국어](README.KO.md) | **English**

This is a personal image storage service for registering and searching images. The web interface and API require Google OpenID Connect login. The environment variables contain a single administrator email address, and the administrator toggles whether regular Google users are allowed access in the UI. The admin interface runs on Cloudflare Worker and D1, while original files and 128×128 WebP previews are stored on a Linux server at home. The public image domain connects directly to the origin server through Cloudflare Tunnel, and successful responses are cached at Cloudflare's edge.

If you arrived after seeing an earlier Reddit post, the Workers VPC configuration from that time is preserved in the [`v1-vpc-final` tag and release](https://github.com/octopus7/meme/releases/tag/v1-vpc-final). When installing anew or migrating, use the current direct Tunnel configuration below.

## Architecture

```text
Browser
├─ app.example.com  ─ Google authentication ─ web Worker ─ D1
├─ img.example.com  ─ Public ─ Cloudflare edge cache ─ Tunnel ─ Node origin
└─ origin-admin.example.com  ─ Bearer token ─ Tunnel ─ Node origin
```

- An authenticated user's `/` redirects to `/all`. When not logged in, the login button is displayed.
- `/search` starts with an empty search input screen and searches only items uploaded by logged-in users.
- `/all` displays only items uploaded by logged-in users, one page at a time.
- If you know an original image URL directly, you can still open the file as before, but other users' items cannot be found through the list or search.
- From the gear icon on `/all`, an administrator can view member access settings and the 90-day image URL exposure records.
- The exposure record is a best-effort audit log in which the web Worker records the time, filename, size, screen, and viewer sub when it includes a URL in an `/all` or `/search` response. It cannot determine actual downloads, browser caching, or whether Cloudflare returned a HIT.
- `/i/{sha256}.{ext}` is the original, and `/t/{sha256}` is the 128×128 WebP preview.
- Physical files are deduplicated by content hash, while descriptions and original filenames are managed in D1 as separate references.
- When the last reference is deleted, the public path is invalidated immediately and the cache tags are purged. The file is kept in a trash area for 30 days, where only an administrator can restore it, and is then deleted.

## Installation and operations documentation

1. [Architecture and request flow](docs/architecture.md)
2. [Complete installation sequence](docs/installation.md)
3. [D1, Tunnel, CDN, and Worker configuration](docs/cloudflare.md)
4. [Installing the Node.js origin service](docs/origin.md)
5. [GitHub Actions variables, secrets, and isolation policies](docs/github-actions.md)
6. [Google OAuth configuration](docs/google-oauth.md)
7. [Cache, deletion, and restoration behavior](docs/operations.md)
8. [Operations setup checklist](docs/setup-checklist.md)

Actual account IDs, database IDs, domains, tokens, and Tunnel tokens are not committed to the repository. The `<...>` values in the examples must be configured in the Cloudflare dashboard or GitHub Environment.

## Repository isolation

| Directory | Deployment target |
|---|---|
| `workers/web` | Google-authenticated web UI and D1 API Worker |
| `origin` | Node.js image storage service, default port 8086 |
| `database/d1/migrations` | D1 schema |
| `.github/workflows` | Independent CI/CD by target |

Each Worker uses a separate lockfile and GitHub Environment. Deploying a Worker does not modify another Worker, D1 migrations, or files on the Linux server.
