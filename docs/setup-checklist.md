# 운영 설정 체크리스트

실제 ID, 도메인, 이메일과 토큰은 저장소에 기록하지 않습니다. 이전 Reddit 글에서
VPC 구성을 찾아온 설치자는 [v1-vpc-final 릴리스](https://github.com/octopus7/meme/releases/tag/v1-vpc-final)를
참조하고, 아래 체크리스트는 현재 직접 Tunnel 구조에 적용합니다.

## 1. Origin 설치

- [ ] Node origin `8086` 설치
- [ ] `/volume1/docker/meme-origin`에 설치
- [ ] Container Manager project와 health 상태 확인
- [ ] 로컬 `/healthz` 성공 확인
- [ ] origin mutation token 생성 및 백업 정책 확인
- [ ] 라우터 포트 포워딩이 없는지 확인

## 2. Tunnel·CDN

- [ ] Cloudflare Tunnel 생성 및 Synology에 `cloudflared` 설치
- [ ] `img.example.com` → Node origin `8086` published route 생성
- [ ] `origin-admin.example.com` → 같은 origin published route 생성
- [ ] origin mutation Bearer token을 web Worker와 Synology에 동일하게 설정
- [ ] `img.example.com`은 GET/HEAD `/i/*`, `/t/*`만 허용
- [ ] `img.example.com/internal/*`, `/healthz`와 모든 쓰기 메서드 차단
- [ ] `/i/*`, `/t/*` Cache Rule 생성(확장자 없는 `/t/{hash}` 포함)
- [ ] 200/206 edge TTL 1년, 404/5xx 미캐시, query key 정책 확인
- [ ] Zone cache purge API token 생성(태그 purge 최소 권한)
- [ ] 이미지 origin 응답의 `Cache-Tag: blob-<sha256>` 확인

Workers VPC, VPC Service ID, `Connectivity Directory Bind`와 storage Worker는
현재 구성에 필요하지 않습니다.

## 3. GitHub Environments

### `web-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `WEB_WORKER_NAME`
- [ ] `D1_DATABASE_NAME`
- [ ] `D1_DATABASE_ID`
- [ ] `IMAGE_ORIGIN=https://<IMAGE_DOMAIN>`
- [ ] `ORIGIN_ADMIN_BASE_URL=https://<ORIGIN_ADMIN_DOMAIN>`
- [ ] `CF_ZONE_ID`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_REDIRECT_URI=https://<APP_DOMAIN>/auth/callback`
- [ ] `GOOGLE_ALLOWED_EMAILS=<관리자 이메일 하나>`

Cloudflare web Worker encrypted secrets:

- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `AUTH_SESSION_SECRET`
- [ ] `ORIGIN_ADMIN_TOKEN` (origin mutation token과 동일)
- [ ] `CF_CACHE_PURGE_TOKEN`

### `d1-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `D1_DATABASE_NAME`
- [ ] `D1_DATABASE_ID`

`storage-production`, `STORAGE_WORKER_NAME`, `VPC_SERVICE_ID`,
`ORIGIN_BASE_URL`은 새 배포에 만들지 않습니다.

## 4. 배포와 기능 점검

- [ ] `Migrate D1` 실행(`image_url_exposure_logs` 포함)
- [ ] `Deploy web Worker` 실행
- [ ] web Worker에 `app.example.com` Custom Domain 연결
- [ ] Tunnel route와 Cache Rule이 배포 후에도 유지되는지 확인
- [ ] 인증 없는 브라우저가 Google 인증 화면으로 이동하는지 확인
- [ ] 관리자 계정으로 목록, 검색, 업로드가 동작하는지 확인
- [ ] `/all`·`/search`의 이미지 URL이 `img.example.com`을 가리키는지 확인
- [ ] 노출 기록에 시각·파일명·용량·화면·viewer sub가 남는지 확인
- [ ] `img.example.com/i/...`와 `/t/...`가 인증 없이 GET/HEAD 동작하는지 확인
- [ ] 두 번째 요청에서 `Cf-Cache-Status: HIT`인지 확인
- [ ] `img.example.com/internal/*`가 차단되고 `origin-admin` mutation token이 검증되는지 확인
- [ ] 마지막 참조 삭제가 origin trash 이동 → cache-tag purge → D1 확정 순서인지 확인
- [ ] purge 후 새 네트워크 요청에서 이미지 URL이 404인지 확인(브라우저 로컬 캐시는 남을 수 있음)
- [ ] 관리자 `/exposures` 화면에서 기간 조회와 cursor pagination 확인
- [ ] 일반 회원에게 관리자 화면과 노출 기록이 노출되지 않는지 확인

## 5. 장애·운영 시험

- [ ] origin mutation token 누락·오류 시 관리 API가 거부되는지 확인
- [ ] origin mutation token 불일치 시 업로드·삭제가 거부되는지 확인
- [ ] Cloudflare purge 실패 시 `trash_pending`으로 남고 cron이 재시도하는지 확인
- [ ] D1 장애 중에도 이미지 응답과 목록 응답이 실패하지 않는지 확인
- [ ] Tunnel 중단, 디스크 부족, 30일 purge를 별도 시험 데이터로 검증
