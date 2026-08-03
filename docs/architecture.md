# Service and equipment connectivity architecture

[한국어](architecture.KO.md) | **English**

The current configuration separates public image paths from administrative paths. Public images are delivered directly to the Node origin through Cloudflare CDN and Tunnel, without a separate image Worker. Actual account IDs, domains, database IDs, and tokens are not recorded in the repository.

## Presentation overview

![meme private image platform architecture](assets/meme-architecture-presentation.png)

## Overall architecture

```mermaid
flowchart LR
    U["Browser"]
    subgraph CF["Cloudflare"]
        W["Google-authenticated web Worker<br/>/search · /all · upload · delete"]
        D[("D1<br/>image metadata · access settings<br/>image URL exposure logs")]
        C["Cloudflare Edge/CDN<br/>img.example.com<br/>/i/{hash}.{ext} · /t/{hash}"]
        T["Cloudflare Tunnel"]
    end

    subgraph HOME["Home network · Synology Docker"]
        O["Node.js origin<br/>127.0.0.1:8086"]
        F[("active<br/>original + 128×128 WebP")]
        X[("trash<br/>admin restore · delete after 30 days")]
    end

    U -->|"Google OAuth + signed session"| W
    W <--> D
    U -->|"Anyone who knows the address<br/>public image GET/HEAD"| C
    W -.->|"Public URLs included in lists and search"| C
    C -->|"cache MISS"| T
    W -->|"HTTPS + Bearer origin token"| T
    T --> O
    O <--> F
    O -->|"Last reference deleted"| X
    X -->|"Restore at administrator's discretion"| F
```

The `web Worker` requires Google OpenID Connect login. Access is controlled by one administrator email and the member-access setting in D1, while administrative paths and exposure logs are visible only to the administrator. `/all` and `/search` query only the current user's items, and public image GET/HEAD requests from users who know the hash URL are handled by `img.example.com`.

`img.example.com` exposes only image paths and caches successful responses for one year through a Cache Rule. `origin-admin.example.com` is a public administrative hostname, but mutation requests require the origin Bearer token. Only the web Worker holds and sends this token for administrative requests, and both hosts reach the internal Node.js origin through the same Tunnel connector.

## Image retrieval and edge cache

```mermaid
flowchart TD
    Q["GET/HEAD /i/{hash}.{ext}<br/>or /t/{hash}"]
    R["img.example.com<br/>method and canonical path check"]
    C{"Cloudflare Edge/CDN<br/>Cache Rule"}
    H["HIT<br/>response from edge"]
    V["MISS<br/>Cloudflare Tunnel"]
    O["Node origin 8086<br/>read active file"]
    E["200/206/304<br/>Cache-Control 1 year<br/>Cache-Tag: blob-{hash}"]
    N["404/error<br/>no-store"]

    Q --> R --> C
    C -->|"HIT"| H
    C -->|"MISS"| V --> O
    O -->|"success"| E --> H
    O -->|"404/error"| N
```

When the cache is a HIT, no request reaches the Tunnel or Synology. Public image responses return `Cache-Control: public, max-age=31536000, immutable` and `Cache-Tag: blob-{sha256}`, while 404 and failure responses are not stored. Because the web Worker does not see image GET requests, it cannot record HIT/MISS, POP, or whether the image was actually received in D1.

Instead, when the web Worker includes an image URL in an `/all` or `/api/search` response, it records the timestamp, filename, byte size, screen (`all`/`search`), and viewer sub in `image_url_exposure_logs` on a best-effort basis. This record does not mean that the image was actually downloaded or that browser or Cloudflare cache was used.

## Upload and deletion

```mermaid
sequenceDiagram
    actor U as User
    participant W as web Worker
    participant D as D1
    participant A as origin-admin.example.com
    participant O as Node origin (8086)
    participant C as Cloudflare Zone API

    U->>W: image + description + original filename
    W->>A: HTTPS + Bearer origin token
    A->>O: stream upload through Tunnel
    O->>O: format validation, SHA-256, thumbnail generation
    O-->>W: hash, extension, MIME, size
    W->>D: record blob and user reference
    Note over O: Reuse the existing file for the same hash

    U->>W: delete user item
    W->>D: remove reference, trash_pending if last reference
    W->>A: /internal/v1/blobs/{hash}/trash
    A->>O: atomically move from active to trash
    W->>C: purge_cache(tags=[blob-{hash}])
    W->>D: trashed, purge_after = +30 days
```

When the last reference is deleted, processing occurs in the order of moving the origin file, purging the Zone cache tag, and finalizing the D1 state. The short interval between the origin move and global purge is allowed; failed cleanup remains `trash_pending` so cron can retry it idempotently. Browser-local caches cannot be cleared by Cloudflare purge, so a screen that was already visited may retain a one-year cache.

## Isolated deployment from a single repository

```mermaid
flowchart TB
    GH["GitHub repository"]

    subgraph GA["GitHub Actions · path-specific triggers and Environments"]
        WW["deploy-web-worker.yml<br/>web-production"]
        DB["migrate-d1.yml<br/>d1-production · manual approval"]
        OB["build-origin.yml<br/>Node.js + Docker validation<br/>Linux x64 artifact"]
    end

    GH -->|"workers/web/**"| WW --> W["web Worker only"]
    GH -->|"database/d1/**"| DB --> D[("D1 schema only")]
    GH -->|"origin/**"| OB --> AR["Docker/Compose artifact"]
    AR -->|"build/recreate in Container Manager"| O["Node origin container"]
```

The web Worker, D1 migration, and origin build each have an independent workflow and do not change one another's deployment targets. The public image hostname, Tunnel, and Cache Rule are operated in the Cloudflare dashboard; there is no separate storage Worker or Workers VPC deployment. The origin workflow only creates an artifact and does not change the server.

Wrangler's actual configuration is generated temporarily during the Actions run and removed afterward. The Cloudflare API token, origin administration token, and cache purge token are stored as GitHub Environment secrets, while the account, D1, host, and Worker names are Environment variables. Actual values are not committed to the repository or deployment workflows.
