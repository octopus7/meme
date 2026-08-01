# Cloudflare 인프라

계정별 값은 Cloudflare 대시보드와 GitHub Environment에만 둡니다. 실제 도메인,
account/zone/database ID와 API token은 저장소에 기록하지 않습니다.

## D1

D1에는 물리 blob, 컬렉션 항목, 이미지 URL 노출 기록을 저장합니다. migration의 기준
원본은 `database/d1/migrations`이며 운영 migration은 Worker 배포와 분리된 수동
워크플로로 적용합니다.

```text
blob: SHA-256, canonical extension, MIME, size, active/trashed 상태
item: 소유자 식별값, blob hash, 설명, 원래 파일명, 생성/삭제 시각
image_url_exposure_logs: URL을 HTML 응답에 포함한 시각, 항목, 파일명, byte 크기, 화면, viewer sub
```

노출 기록은 실제 이미지 요청·다운로드·Cloudflare cache HIT를 의미하지 않습니다.
web Worker가 `/all` 또는 `/search` 응답에 이미지 URL을 포함한 시점만 기록합니다.

데이터베이스는 한 번만 생성합니다.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

반환된 이름과 ID를 `web-production`, `d1-production` Environment의
`D1_DATABASE_NAME`, `D1_DATABASE_ID`에 동일하게 저장합니다.

## Tunnel 및 공개 이미지 hostname

Workers VPC와 VPC Service는 사용하지 않습니다. Synology의 Node origin은
Cloudflare Tunnel의 private network 뒤에 두고, 두 개의 published hostname을
같은 origin 포트(기본 `8086`)로 연결합니다.

```text
img.example.com
  공개 GET/HEAD /i/*, /t/*
  Cloudflare CDN → Tunnel → Synology origin

origin-admin.example.com
  Cloudflare Access Service Auth 필요
  web Worker → Tunnel → Synology /internal/*
```

NAS 라우터에 포트 포워딩을 만들지 않습니다. Tunnel connector는 Synology에서
실행하고 토큰은 Linux 서비스 자격 증명에만 보관합니다. SSH, DSM UI와 그 밖의
관리 포트를 Tunnel public hostname에 노출하지 않습니다.

`img.example.com`은 다음 요청만 허용합니다.

- `GET`, `HEAD`의 `/i/*`, `/t/*`
- 그 밖의 경로(`/internal/*`, `/healthz`)와 쓰기 메서드는 차단

`origin-admin.example.com`은 Cloudflare Access 정책에서 서비스 토큰 인증만
허용합니다. web Worker는 다음 두 인증 계층을 모두 보냅니다.

```http
CF-Access-Client-Id: <secret>
CF-Access-Client-Secret: <secret>
Authorization: Bearer <origin mutation token>
```

Access가 우회되더라도 origin의 bearer token 검증이 통과해야 하며, 가능하면
origin에서도 Host와 허용 경로를 검증합니다.

## 공개 이미지 CDN 캐시

공개 이미지는 storage Worker를 거치지 않고 Cloudflare CDN이 캐시합니다. Cache
Rules에서 `img.example.com`의 `/i/*`, `/t/*`를 명시적으로 cache eligible로
설정합니다(`/t/{hash}`는 확장자가 없으므로 반드시 규칙에 포함합니다).

정상 이미지 응답은 origin에서 다음 헤더를 보냅니다.

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Tag: blob-<sha256>
```

브라우저의 장기 캐시는 허용합니다. 삭제 시 브라우저 캐시는 원격 purge할 수
없지만, Cloudflare edge 캐시는 Zone Purge API로 `blob-<sha256>` 태그를 지웁니다.
404·401·4xx·5xx는 `Cache-Control: no-store`로 반환하고 장기 저장하지 않습니다.
query string은 캐시 키에 넣지 않거나 공개 경로에서 거부하고, GET/HEAD 외 메서드는
캐시하지 않습니다.

삭제 순서는 반드시 다음과 같습니다.

```text
D1 trash_pending
→ origin-admin의 active → trash 이동
→ Cloudflare Zone purge_cache(tags=[blob-<hash>])
→ D1 trashed
```

Purge 실패 시 `trash_pending`을 유지해 web Worker cron이 재시도합니다.

공식 문서:

- [Cloudflare Tunnel routing](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/)
- [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Purge by cache tag](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/)

## web Worker

web Worker는 `cache.enabled=false`로 배포하며 D1만 바인딩합니다.

```text
DB  D1 database
```

이미지 URL은 `IMAGE_ORIGIN`을 기준으로 만들고 실제 이미지 GET은 Worker에 들어오지
않습니다. 업로드·삭제·복구 관련 origin 관리 요청은 `ORIGIN_ADMIN_BASE_URL`로
직접 HTTPS fetch합니다.

## 도메인과 secret

Custom Domain, Tunnel hostname, Access application/policy와 Cache Rule은
대시보드에서 설정합니다. Wrangler 파일이나 소스에 실제 값은 넣지 않습니다.

GitHub `web-production` 변수:

- `CF_ACCOUNT_ID`, `WEB_WORKER_NAME`
- `D1_DATABASE_NAME`, `D1_DATABASE_ID`
- `IMAGE_ORIGIN` (예: `https://img.example.com`)
- `ORIGIN_ADMIN_BASE_URL` (예: `https://origin-admin.example.com`)
- `CF_ZONE_ID`
- Google OAuth 관련 변수

web Worker encrypted secrets:

- `GOOGLE_CLIENT_SECRET`
- `AUTH_SESSION_SECRET`
- `ORIGIN_ADMIN_TOKEN` (origin의 mutation token과 동일)
- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`
- `CF_CACHE_PURGE_TOKEN` (대상 Zone의 Cache Purge 권한만)

GitHub Actions의 `CLOUDFLARE_API_TOKEN`은 web Worker 배포 및 D1 migration
Environment에서 각각 최소 권한으로 관리합니다. Access service token과 purge
token은 GitHub 로그나 저장소에 노출하지 않습니다.
