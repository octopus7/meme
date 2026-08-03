# Google 인증 웹 Worker

**한국어** | [English](README.md)

이 디렉터리는 독립적으로 배포됩니다. Cloudflare account ID, D1 ID, 호스트명과
API token은 저장하지 않습니다.

## 설정 생성

CI는 GitHub Environment 변수로 아래 값을 제공한 뒤
`.github/scripts/render-web-wrangler.mjs`를 실행합니다. 생성되는
`.wrangler.generated.jsonc`와 Worker 타입 파일은 Git에서 무시됩니다.

- `WEB_WORKER_NAME`
- `IMAGE_ORIGIN`
- `ORIGIN_ADMIN_BASE_URL`
- `CF_ZONE_ID`
- `D1_DATABASE_NAME`
- `D1_DATABASE_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_ALLOWED_EMAILS`

`CLOUDFLARE_API_TOKEN`은 GitHub Environment secret으로, `CF_ACCOUNT_ID`는
Environment variable로 관리합니다. 다음 값은 web Worker의 Cloudflare encrypted
secret으로 직접 등록합니다.

- `GOOGLE_CLIENT_SECRET`
- `AUTH_SESSION_SECRET`
- `ORIGIN_ADMIN_TOKEN`
- `CF_CACHE_PURGE_TOKEN`

`ORIGIN_ADMIN_TOKEN`은 origin의 `MEME_ORIGIN_MUTATION_TOKEN`과 동일해야 합니다.
`origin-admin.example.com` 관리 요청은 이 bearer token으로 인증하고, purge token은
이미지 Zone의 cache-tag purge만 허용합니다. 자세한 발급 및 URL
설정은 `docs/cloudflare.md`, `docs/google-oauth.md`를 참고합니다.

## 런타임 역할

이미지 조회는 web Worker가 처리하지 않습니다.

```text
목록·검색 HTML
  web Worker → IMAGE_ORIGIN URL 포함 → D1 노출 기록

이미지 GET
  브라우저 → Cloudflare CDN → Tunnel → Synology origin(캐시 MISS일 때만)
```

`IMAGE_ORIGIN`은 `https://img.example.com`처럼 공개 이미지 CDN hostname이어야
합니다. 브라우저가 이 URL을 실제로 요청했는지, 로컬 캐시에서 읽었는지, CDN HIT인지
는 web Worker에서 알 수 없습니다.

업로드·삭제·복구 같은 관리 요청은 `ORIGIN_ADMIN_BASE_URL`로 직접 HTTPS fetch합니다.
web Worker는 다음 헤더를 보냅니다.

```http
Authorization: Bearer <origin mutation token>
```

별도 image Worker 서비스 바인딩이나 Workers VPC binding은 사용하지 않습니다. 업로드는
원본 이미지 스트림을 origin의 `POST /internal/v1/blobs`로 전달하고, 마지막 참조
삭제는 다음 순서로 처리합니다.

```text
D1 trash_pending
→ POST /internal/v1/blobs/:sha256/trash
→ Cloudflare Zone cache-tag purge(blob-<sha256>)
→ D1 trashed
```

purge가 실패하면 `trash_pending`으로 남겨 cron이 재시도합니다. origin과 purge가
완료되기 전에는 삭제를 확정하지 않습니다.

`/all`과 `/search`에서 이미지 URL을 HTML에 포함할 때 다음 정보를
`image_url_exposure_logs`에 best-effort로 기록합니다.

```text
exposed_at, image_item_id, blob_hash, original_filename,
byte_size, exposure_context, viewer_sub
```

이 기록은 다운로드·요청·cache HIT가 아닌 URL 노출 시각입니다. 관리자 화면의
`/exposures`에서 기간 조회와 cursor pagination을 제공하고, 10분 cron이 90일이
지난 행을 bounded batch로 정리합니다. 기록 실패는 사용자 페이지 응답을 막지
않습니다.

## 로컬 검사
테스트용 Environment 변수로 설정 파일을 생성한 다음 실행합니다.

```sh
node ../../.github/scripts/render-web-wrangler.mjs .wrangler.generated.jsonc
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --config .wrangler.generated.jsonc --dry-run
```

생성된 `.wrangler.generated.jsonc`와 `src/worker-configuration.d.ts`는 검사 후
삭제합니다. 실제 secret은 로컬 파일이나 명령행에 기록하지 않습니다.

업로드 본문은 multipart가 아닌 원본 이미지 스트림입니다. 설명과 원래 파일명은
브라우저가 URL 인코딩한 요청 헤더로 전달하므로 Worker가 이미지 전체를 버퍼링하지
않고 origin 관리 hostname으로 전달할 수 있습니다.
