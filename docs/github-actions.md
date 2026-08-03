# GitHub Actions configuration and deployment isolation

[한국어](github-actions.KO.md) | **English**

The current configuration has no storage Worker or Workers VPC deployment. In **Settings → Environments** for the GitHub repository, create only the following Environments for production use.

```text
web-production
d1-production
```

`Build origin` does not deploy to the server; it only creates a Docker validation artifact. For production deployment Environments, required reviewers and main-branch protection are recommended. Do not put Linux server SSH keys or the Tunnel token in any Worker Environment.

## Environment values

### web-production

| Type | Name | Content |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | Minimum-permission token that can deploy only the web Worker |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `WEB_WORKER_NAME` | web Worker script name |
| variable | `D1_DATABASE_NAME` | D1 display name |
| variable | `D1_DATABASE_ID` | D1 database ID |
| variable | `IMAGE_ORIGIN` | Public image origin, for example `https://img.example.com` |
| variable | `ORIGIN_ADMIN_BASE_URL` | Administrative hostname protected by a Bearer token, for example `https://origin-admin.example.com` |
| variable | `CF_ZONE_ID` | Image Zone ID |
| variable | `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| variable | `GOOGLE_REDIRECT_URI` | `https://<APP_DOMAIN>/auth/callback` |
| variable | `GOOGLE_ALLOWED_EMAILS` | One administrator email |

Cloudflare web Worker encrypted secrets:

| Name | Content |
|---|---|
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret |
| `AUTH_SESSION_SECRET` | Random secret for signing sessions |
| `ORIGIN_ADMIN_TOKEN` | Bearer token identical to origin `MEME_ORIGIN_MUTATION_TOKEN` |
| `CF_CACHE_PURGE_TOKEN` | API token that permits only Cache Purge for the target Zone |

Do not create `ORIGIN_ADMIN_TOKEN` or the purge token as GitHub variables. The deployment workflow does not print secrets or overwrite them with `wrangler secret put`; it preserves the values registered in Cloudflare Worker Settings with `--keep-vars`.

### d1-production

| Type | Name | Content |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | Minimum-permission token that can run migrations on the target D1 only |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `D1_DATABASE_NAME` | Target D1 name for migration |
| variable | `D1_DATABASE_ID` | Target D1 ID for migration |

Manage the account ID and resource ID as GitHub variables so they are not hard-coded in the repository, even though they are not secret credentials. Always manage API tokens as secrets.

## Minimum token permissions

Limit each token's resource scope to the production account and the required Zone/database.

- `web-production`: Account → Workers Scripts → Edit
- `CF_CACHE_PURGE_TOKEN` in `web-production`: target Zone → Cache Purge → allow only Purge by cache-tag
- `d1-production`: Account → D1 → Edit

Configure the Tunnel connector token only in the Cloudflare dashboard and on Synology. `Connectivity Directory Bind` for Workers VPC, the VPC Service ID, and deployment tokens for a storage Worker are no longer needed.

Official references:

- [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cache purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)

## Scope of each workflow

| Workflow | Trigger | Changed target |
|---|---|---|
| `Deploy web Worker` | Push to `workers/web/**` or manual | web Worker only |
| `Build origin` | Push/PR to `origin/**` or manual | Node.js 24 Docker validation and Linux x64 artifact only |
| `Migrate D1` | Manual | D1 schema only |

Remove the `Deploy storage Worker` workflow and `render-storage-wrangler.mjs`. Each deployment job runs `npm ci` and Wrangler only in its own directory, creates `.wrangler.generated.jsonc` at runtime, and deletes it on exit. The file is also included in `.gitignore`.

The workflow does not create or change Custom Domains, Tunnel routes, or Cache Rules. Create them first in the Cloudflare dashboard and confirm them with a smoke test. Worker deployment also has no step that copies or deletes Linux files or restarts services.

The origin workflow validates `npm ci`, tests, loading `sharp` for Linux x64, and Docker image building on Node.js 24, then creates only an artifact. It does not use server-access credentials.

## D1 migration

`Migrate D1` allows only `workflow_dispatch` and requires approval for `d1-production`. Before running it, secure a backup that follows the operating policy, such as a Cloudflare D1 export. Prefer reversible additive migrations, and split removal of columns or tables incompatible with the Worker into a separate release.

Recommended deployment order:

```text
additive D1 migration
→ web Worker
→ smoke test (Tunnel, CDN cache, purge, exposure log)
→ follow-up cleanup migration
```

`image_url_exposure_logs` records when the web Worker includes an image URL in `/all` or `/search` HTML. It does not represent an actual browser download or CDN HIT; after 90 days, the web Worker cron cleans it up in bounded batches.

## Runtime secret check

Verify the following before deployment.

1. `ORIGIN_ADMIN_BASE_URL` uses `https://` and points to the administrative hostname.
2. `ORIGIN_ADMIN_TOKEN` matches the origin mutation token.
3. `CF_ZONE_ID` is the Zone for `IMAGE_ORIGIN`, and the purge token can perform only tag purges for that Zone.
4. Secret values do not appear in workflow logs, generated Wrangler files, or commits.
