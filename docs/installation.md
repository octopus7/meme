# 설치 순서

이 문서는 현재의 직접 이미지 CDN + Tunnel 구성을 최초로 만드는 순서입니다.
모든 `<PLACEHOLDER>`는 운영자가 직접 만든 값으로 바꾸되 저장소에는 기록하지
않습니다.

이전 Reddit 글을 보고 VPC 기반 구성을 찾은 경우에는 [v1-vpc-final 릴리스](https://github.com/octopus7/meme/releases/tag/v1-vpc-final)를
사용하세요. 이 문서와 `main`은 현재 구조를 기준으로 합니다.

## 준비 사항

- Cloudflare에 연결된 도메인과 Zone
- GitHub Actions가 활성화된 저장소
- x86-64 Synology/XPEnology의 Container Manager(Docker)
- Synology에서 Cloudflare로 나가는 HTTPS 연결
- origin 데이터 디렉터리를 위한 충분한 디스크와 별도 백업

권장 hostname은 다음과 같습니다.

```text
app.example.com          Google 인증 웹 Worker
img.example.com          공개 이미지 CDN → Tunnel → origin
origin-admin.example.com Access 보호 관리 API → Tunnel → origin
```

`img.example.com`은 URL을 아는 누구나 접근할 수 있으므로 주소 자체를 비밀로
간주하면 안 됩니다. 업로드·삭제·복구 API는 `origin-admin.example.com`으로
분리하고 Cloudflare Access Service Auth로 보호합니다.

## 1. Linux origin 설치

- [Node.js 24 Docker origin 설치](origin.md): Container Manager project, 기본
  `127.0.0.1:8086`

서비스는 loopback 또는 Tunnel이 도달할 수 있는 사설 주소에서만 수신하게 하고
라우터의 포트 포워딩은 만들지 않습니다. Synology DSM에 Node를 직접 설치하지
않고 Debian Bookworm 기반 Node.js 24 LTS 컨테이너를 사용합니다. 설치 소스는
`https://github.com/octopus7/meme`의 `origin/`이며 실제 `.env`와 token은 NAS에만
둡니다.

서비스가 정상인지 Linux 서버에서 확인합니다.

```bash
curl --fail http://127.0.0.1:8086/healthz
```

## 2. Tunnel과 hostname 생성

1. Cloudflare Tunnel을 만들고 Synology에 `cloudflared` connector를 설치합니다.
2. `img.example.com` published route를 Node origin의 내부 `8086` 포트에 연결합니다.
3. `origin-admin.example.com` published route도 같은 origin에 연결합니다.
4. `origin-admin.example.com`을 Cloudflare Access application으로 등록하고
   Service Auth 정책에서 web Worker의 `CF-Access-Client-Id`/secret만 허용합니다.
5. `img.example.com`에는 `/i/*`, `/t/*`의 GET/HEAD만 허용하고
   `/internal/*`, `/healthz`, 모든 쓰기 메서드를 WAF 또는 hostname 규칙으로
   차단합니다.

Tunnel token은 Linux의 systemd 자격 증명 또는 Cloudflare 설치 절차에만 사용하고
GitHub에는 저장하지 않습니다. NAS 라우터의 외부 포트 포워딩은 만들지 않습니다.

## 3. Cloudflare Cache Rule과 purge token

`img.example.com` Zone에 다음 Cache Rule을 설정합니다.

- `/i/*`, `/t/*`를 명시적으로 cache eligible로 지정
- `/t/{hash}`처럼 확장자가 없는 경로도 포함
- 200/206 응답의 edge TTL은 1년
- 404와 5xx는 캐시하지 않음
- query string은 캐시 키에서 제거하거나 공개 경로에서 거부
- GET/HEAD 외 메서드는 캐시하지 않음

대상 Zone에 한정된 Cache Purge API token을 만들고 Worker secret
`CF_CACHE_PURGE_TOKEN`으로 등록합니다. 삭제 시 `blob-<sha256>` cache tag를
전역 purge합니다. purge는 브라우저 로컬 캐시를 지우지 않으며, 이후 새 네트워크
요청이 edge MISS일 때 origin 상태를 다시 확인하게 합니다.

## 4. D1 생성

Cloudflare 대시보드 또는 인증된 Wrangler로 D1을 한 번 생성합니다.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

데이터베이스 이름과 ID를 GitHub `web-production`, `d1-production` Environment에
등록하고 [D1 migration 워크플로](github-actions.md#d1-migration)를 수동 실행합니다.
노출 기록 테이블(`image_url_exposure_logs`) migration도 이 단계에서 적용됩니다.

## 5. GitHub Environment와 web Worker secret

`web-production` 변수에 다음을 등록합니다.

```text
CF_ACCOUNT_ID
WEB_WORKER_NAME
D1_DATABASE_NAME
D1_DATABASE_ID
IMAGE_ORIGIN=https://<IMAGE_DOMAIN>
ORIGIN_ADMIN_BASE_URL=https://<ORIGIN_ADMIN_DOMAIN>
CF_ZONE_ID
GOOGLE_CLIENT_ID
GOOGLE_REDIRECT_URI=https://<APP_DOMAIN>/auth/callback
GOOGLE_ALLOWED_EMAILS=<관리자 이메일 하나>
```

Cloudflare web Worker encrypted secrets에는 다음을 등록합니다.

```text
GOOGLE_CLIENT_SECRET
AUTH_SESSION_SECRET
ORIGIN_ADMIN_TOKEN
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
CF_CACHE_PURGE_TOKEN
```

`ORIGIN_ADMIN_TOKEN`은 origin의 `MEME_ORIGIN_MUTATION_TOKEN`과 동일해야 합니다.
모든 secret은 32자 이상의 무작위 값으로 만들고 GitHub 변수나 로그에 넣지 않습니다.

## 6. Worker 최초 배포

GitHub Actions에서 다음 순서로 실행합니다.

1. `Migrate D1`
2. `Deploy web Worker`
3. Cloudflare 대시보드에서 web Worker에 `app.example.com` Custom Domain 연결
4. `img.example.com`과 `origin-admin.example.com` Tunnel route/Access/Cache Rule 확인

storage Worker 배포 단계는 없습니다. 이미지 GET은 web Worker가 아니라 Cloudflare
CDN에서 처리하며, web Worker는 목록·검색 HTML에 `IMAGE_ORIGIN` URL을 포함한 시각을
D1 노출 기록으로 남깁니다. 이 기록은 실제 다운로드나 HIT를 의미하지 않습니다.

## 7. 운영 점검

- 비공개 브라우저 창에서 `app.example.com`을 열면 Google 인증 화면으로 이동합니다.
- 관리자 Google 계정으로 로그인한 뒤 `/`가 `/all`로 이동합니다.
- 업로드가 성공하고 원본은 `origin-admin.example.com`을 통해 Synology에 저장됩니다.
- `/all`과 `/search`의 이미지 URL이 `img.example.com`을 가리키며 노출 기록에
  시각·파일명·용량·화면·viewer sub가 남습니다.
- `img.example.com/i/...`와 `/t/...`는 인증 없이 GET/HEAD가 동작하고, 두 번째
  요청에서 Cloudflare `Cf-Cache-Status`가 `HIT`인지 확인합니다.
- `img.example.com/internal/*`와 `origin-admin.example.com`의 Access 없는 요청은
  차단됩니다.
- 마지막 참조 삭제가 origin trash 이동과 cache-tag purge를 모두 완료한 뒤 새
  네트워크 요청에서 두 이미지 URL이 404가 됩니다(브라우저 로컬 캐시는 남을 수 있음).
- `/admin`에서 이미지 URL 노출 기록 화면이 열리고, 일반 회원에게는 관리자 화면이
  보이지 않는지 확인합니다.

실서비스 전에는 업로드 중 장애, D1 실패, Tunnel 중단, 디스크 부족과 purge 실패
재시도를 별도 시험 데이터로 검증합니다.
