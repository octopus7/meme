# Cloudflare Access와 Google 로그인

웹 호스트만 Cloudflare Access로 보호합니다. 공개 이미지 호스트에는 로그인
확인을 두지 않습니다.

## Google identity provider

먼저 Zero Trust의 **Settings → Team name and domain**에서 team name을 확인합니다.
이 값은 공개 앱 도메인이 아니라 `<team>.cloudflareaccess.com` 주소에 사용됩니다.

Google Cloud Console에서 다음 순서로 OAuth client를 만듭니다.

1. 전용 project를 만들고 **APIs & Services → Credentials**로 이동합니다.
2. OAuth consent screen을 구성합니다. 개인 Google 계정용이면 audience를
   `External`로 선택하고 실제 로그인 계정만 test user로 제한할 수 있습니다.
3. **Create OAuth client → Web application**을 선택합니다.
4. Authorized JavaScript origins에
   `https://<team>.cloudflareaccess.com`을 등록합니다.
5. Authorized redirect URIs에
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`을 등록합니다.
6. 생성된 client ID와 secret을 복사합니다. secret은 저장소나 GitHub에 넣지 않습니다.

이어서 Cloudflare Zero Trust의 **Integrations → Identity providers → Add new
identity provider → Google**에서 App ID와 client secret을 입력하고 저장합니다.
필요하면 PKCE를 켭니다. 일반 Google 계정을 허용할지 Google Workspace 조직과
그룹을 사용할지는 운영 계정 정책에 맞게 선택합니다.

설정 후 Zero Trust의 로그인 방법 테스트를 먼저 실행합니다. OAuth client ID나
secret을 저장소 또는 GitHub Actions에 복사할 필요가 없습니다.

공식 문서:

- [Google identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

## Self-hosted application

Zero Trust에서 **Access controls → Applications → Add an application →
Self-hosted**를 선택하고 다음처럼 구성합니다.

```text
Application domain: app.example.com
Path:               /*
Login method:       Google
```

정책은 `Allow` 하나로 시작하고 **Include → Emails**에 실제 허용할 Google 이메일을
각각 등록합니다. 폐쇄형 서비스이므로 `Everyone`, 넓은 이메일 도메인, `Bypass`
규칙은 사용하지 않습니다. 세션 시간은 개인 장비의 위험 수준에 맞게 정합니다.

웹 Worker가 Access 뒤에 있으므로 모든 웹/API 경로와 D1 조회가 동일하게
보호됩니다. `/`는 로그인 완료 후 앱 내부에서 `/search`로 redirect됩니다.

## 사용자 식별

web Worker는 Cloudflare Access가 검증해 전달한 사용자 identity/JWT에서 정규화된
이메일을 사용자 키로 사용합니다. 클라이언트가 임의로 보낸 `X-User`,
query string 또는 form field를 사용자 identity로 신뢰하지 않습니다.

Access 설정을 우회하는 `workers.dev` 주소가 남아 있으면 보호가 무력화될 수
있습니다. web Worker의 `workers.dev` 공개 여부를 끄고 Custom Domain만 운영
진입점으로 사용합니다.

## 공개 이미지 Worker

`img.example.com`은 Access application에 포함하지 않습니다. 공개 메서드는
다음으로 제한합니다.

```text
GET|HEAD /i/{sha256}.{canonical-extension}
GET|HEAD /t/{sha256}
```

URL을 획득한 사람은 로그인 없이 파일을 볼 수 있습니다. 그 외 method와 임의
proxy 경로는 거부해야 합니다. 관리 호출은 Worker 간 바인딩 또는 별도로 검증된
내부 API를 통해서만 수행합니다.
