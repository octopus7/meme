# Google 인증 웹 Worker

이 디렉터리는 독립적으로 배포됩니다. Cloudflare 계정 ID, D1 ID, 호스트명과
API 토큰은 저장하지 않습니다.

## 설정 생성

CI는 GitHub Environment 변수로 아래 값을 제공한 뒤
`.github/scripts/render-web-wrangler.mjs`를 실행합니다. 생성되는
`.wrangler.generated.jsonc`와 Worker 타입 파일은 Git에서 무시됩니다.

- `WEB_WORKER_NAME`
- `IMAGE_ORIGIN`
- `D1_DATABASE_NAME`
- `D1_DATABASE_ID`
- `STORAGE_WORKER_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_ALLOWED_EMAILS`

`CLOUDFLARE_API_TOKEN`은 GitHub Environment secret으로, `CF_ACCOUNT_ID`는
Environment variable로 관리합니다. `GOOGLE_CLIENT_SECRET`과
`AUTH_SESSION_SECRET`은 web Worker의 encrypted secret으로 직접 등록합니다.
웹 화면과 API는 유효한 Google 로그인 세션과 허용 이메일이 있어야 접근할 수
있습니다. 자세한 발급 및 URL 설정은 `docs/google-oauth.md`를 참고합니다.

`STORAGE_ADMIN` 서비스 바인딩 계약은 다음과 같습니다.

- `POST /internal/v1/blobs`: 이미지 스트림을 받고
  `{hash,extension,mimeType,size}`.
- `POST /internal/v1/blobs/:sha256/trash`: 원본과 미리보기를 관리자 전용 30일
  휴지통으로 옮기고 해당 엣지 캐시를 퍼지합니다.

최초 배포 전에 별도 권한의 D1 migration workflow로
`database/d1/migrations/0001_initial.sql`을 적용합니다. 10분 주기의 cron은 마지막
D1 참조 삭제 후 실패한 휴지통 이동을 재시도합니다.

## 로컬 검사

테스트용 환경변수로 설정 파일을 생성한 다음 실행합니다.

```sh
node ../../.github/scripts/render-web-wrangler.mjs .wrangler.generated.jsonc
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --config .wrangler.generated.jsonc --dry-run
```

업로드 본문은 multipart가 아닌 원본 이미지 스트림입니다. 설명과 원래 파일명은
브라우저가 URL 인코딩한 요청 헤더로 전달하므로 Worker가 이미지 전체를 버퍼링하지
않고 storage 서비스로 전달할 수 있습니다.
