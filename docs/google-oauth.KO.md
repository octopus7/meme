# Google OAuth 설정

**한국어** | [English](google-oauth.md)

web Worker는 Google OpenID Connect를 사용합니다. `GOOGLE_ALLOWED_EMAILS`에는
검증된 관리자 이메일을 정확히 하나만 지정합니다. 관리자는 비공개 관리자
페이지에서 검증된 다른 Google 계정의 로그인을 모두 허용하거나 차단할 수 있습니다.

## Google Cloud

1. Google Cloud Console을 열고 프로젝트를 선택하거나 생성합니다.
2. **Google Auth Platform > Branding, Audience, and Data Access**를 구성합니다.
3. `openid`, `email`, `profile` scope를 사용합니다.
4. **Clients**에서 애플리케이션 유형이 **Web application**인 OAuth client를
   생성합니다.
5. 정확한 authorized redirect URI를 추가합니다.

```text
https://meme-web.bgue.workers.dev/auth/callback
```

Custom domain을 사용하는 경우 해당 callback URI도 Google에 추가하고, 배포된
`GOOGLE_REDIRECT_URI`에는 그 URI를 선택합니다.

```text
https://meme.example.com/auth/callback
```

Worker는 서버 측 authorization code flow를 사용하므로 Authorized JavaScript
origin은 필요하지 않습니다.

## GitHub 환경

`Settings > Environments > web-production > Environment variables`에 다음을
추가합니다.

```text
GOOGLE_CLIENT_ID=<OAuth web client ID ending in .apps.googleusercontent.com>
GOOGLE_REDIRECT_URI=https://meme-web.bgue.workers.dev/auth/callback
GOOGLE_ALLOWED_EMAILS=owner@example.com
```

쉼표로 구분된 목록은 사용하지 않습니다. 이 변수에는 관리자 이메일을 정확히
하나만 지정할 수 있습니다. 관리자는 항상 허용됩니다. 외부 회원 접근은 기본적으로
비활성화되며, `/all`에서 관리자에게만 표시되는 톱니바퀴 링크에서 변경할 수 있습니다.

## Cloudflare Worker secret

인증 변경 사항을 배포하기 전에 다음 위치를 엽니다.

```text
Cloudflare > Workers & Pages > meme-web > Settings > Variables and Secrets
```

다음을 encrypted secret으로 추가합니다.

```text
GOOGLE_CLIENT_SECRET=<OAuth web client secret from Google>
AUTH_SESSION_SECRET=<at least 32 random bytes>
```

shell history에 남기지 않고 session secret을 생성합니다.

```bash
openssl rand -hex 32
```

Worker는 Google access token이나 refresh token을 저장하지 않습니다. callback에서
서명된 Google ID token을 검증한 다음 `HttpOnly`, `Secure`, `SameSite=Lax` 속성의
12시간 세션 cookie를 발급합니다.
