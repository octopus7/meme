# Google OAuth setup

The web Worker uses Google OpenID Connect. Requests without a valid signed
session cookie are redirected to Google. Only verified accounts listed in
`GOOGLE_ALLOWED_EMAILS` can create a session.

## Google Cloud

1. Open Google Cloud Console and select or create a project.
2. Configure **Google Auth Platform > Branding, Audience, and Data Access**.
3. Use the `openid`, `email`, and `profile` scopes.
4. Under **Clients**, create an OAuth client with application type
   **Web application**.
5. Add the exact authorized redirect URI:

```text
https://meme-web.bgue.workers.dev/auth/callback
```

If a custom domain is used, add its callback URI to Google as well and select
that one as the deployed `GOOGLE_REDIRECT_URI`:

```text
https://meme.example.com/auth/callback
```

An Authorized JavaScript origin is not required because the Worker uses the
server-side authorization code flow.

## GitHub environment

In `Settings > Environments > web-production > Environment variables`, add:

```text
GOOGLE_CLIENT_ID=<OAuth web client ID ending in .apps.googleusercontent.com>
GOOGLE_REDIRECT_URI=https://meme-web.bgue.workers.dev/auth/callback
GOOGLE_ALLOWED_EMAILS=owner@example.com
```

Multiple allowed accounts are comma-separated.

## Cloudflare Worker secrets

Before deploying the authentication change, open:

```text
Cloudflare > Workers & Pages > meme-web > Settings > Variables and Secrets
```

Add these as encrypted secrets:

```text
GOOGLE_CLIENT_SECRET=<OAuth web client secret from Google>
AUTH_SESSION_SECRET=<at least 32 random bytes>
```

Generate the session secret without placing it in shell history:

```bash
openssl rand -hex 32
```

The Worker does not persist Google access tokens or refresh tokens. It
validates the signed Google ID token during the callback and then issues a
12-hour `HttpOnly`, `Secure`, `SameSite=Lax` session cookie.
