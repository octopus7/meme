# 운영 설정 체크리스트

실제 ID, 도메인, 이메일과 토큰은 저장소에 기록하지 않습니다.

## 1. Origin 설치

- [ ] Node `8086` 또는 .NET `8087` 구현 선택
- [ ] NAS 사용자 홈의 `~/meme`에 clone 및 서비스 설치
- [ ] `systemctl status` 확인
- [ ] 로컬 `/healthz` 성공 확인
- [ ] 자동 생성된 origin mutation token 확인
- [ ] 라우터 포트 포워딩이 없는지 확인

## 2. Cloudflare에서 생성·확인

- [ ] Account ID 확인
- [ ] Zero Trust team name/domain 생성: `<TEAM>.cloudflareaccess.com`
- [ ] D1 생성: 이름과 Database ID 기록
- [ ] Cloudflare Tunnel 생성 및 NAS에 `cloudflared` 설치
- [ ] Node용 HTTP VPC Service 생성: 내부 호스트, port `8086`
- [ ] .NET용 HTTP VPC Service 생성: 내부 호스트, port `8087`
- [ ] 사용할 VPC Service ID 선택
- [ ] web Worker 이름 결정
- [ ] storage Worker 이름 결정
- [ ] 같은 이름의 storage Worker를 대시보드에서 한 번 생성
- [ ] web Custom Domain 결정: `https://<APP_DOMAIN>`
- [ ] storage Custom Domain 결정: `https://<IMAGE_DOMAIN>`
- [ ] storage Worker encrypted secret `ORIGIN_ADMIN_TOKEN` 등록
- [ ] web 배포 API token 발급
- [ ] storage 배포 API token 발급
- [ ] D1 migration API token 발급

API token은 대상 account/resource와 필요한 쓰기 권한만 허용합니다.

## 3. GitHub Environments

### `web-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `WEB_WORKER_NAME`
- [ ] `D1_DATABASE_NAME`
- [ ] `D1_DATABASE_ID`
- [ ] `STORAGE_WORKER_NAME`
- [ ] `ACCESS_TEAM_DOMAIN`
- [ ] `ACCESS_AUD`: Google/Access 설정 후 발급된 값
- [ ] `IMAGE_ORIGIN=https://<IMAGE_DOMAIN>`

### `storage-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `STORAGE_WORKER_NAME`
- [ ] `VPC_SERVICE_ID`: 선택한 `8086` 또는 `8087` Service ID
- [ ] `ORIGIN_BASE_URL`: 선택한 origin의 내부 URL

`VPC_SERVICE_ID`와 `ORIGIN_BASE_URL`은 같은 origin을 가리켜야 합니다.

### `d1-production`

Secrets:

- [ ] `CLOUDFLARE_API_TOKEN`

Variables:

- [ ] `CF_ACCOUNT_ID`
- [ ] `D1_DATABASE_NAME`
- [ ] `D1_DATABASE_ID`

## 4. Google 인증

Google Cloud:

- [ ] 새 프로젝트 생성
- [ ] OAuth consent screen 설정
- [ ] Audience 선택: 개인 Google 계정이면 `External`
- [ ] OAuth client 생성: `Web application`
- [ ] Authorized JavaScript origin:
      `https://<TEAM>.cloudflareaccess.com`
- [ ] Authorized redirect URI:
      `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`
- [ ] OAuth Client ID와 Client Secret 발급

Cloudflare Zero Trust:

- [ ] **Integrations → Identity providers → Google** 추가
- [ ] Google Client ID를 `App ID`에 입력
- [ ] Google Client Secret 입력
- [ ] 연결 테스트
- [ ] `https://<APP_DOMAIN>/*` Self-hosted Access application 생성
- [ ] Google login method만 선택
- [ ] Allow policy에 사용할 Google 이메일만 명시
- [ ] Access application의 `AUD` 값을 `ACCESS_AUD`에 등록
- [ ] `https://<IMAGE_DOMAIN>`에는 Access를 적용하지 않음

## 5. 배포 순서

- [ ] `ORIGIN_ADMIN_TOKEN`과 origin mutation token 일치 확인
- [ ] `Deploy storage Worker`
- [ ] storage Custom Domain 연결
- [ ] `Migrate D1`
- [ ] `Deploy web Worker`
- [ ] web Custom Domain 및 Access 연결
- [ ] 로그인, 업로드, 검색, 캐시 HIT, 삭제 후 404 확인
