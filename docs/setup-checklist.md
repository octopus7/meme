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
- [ ] web 배포 API token 발급: Account `Workers Scripts: Edit`
- [ ] storage 배포 API token 발급: Account `Workers Scripts: Edit`
- [ ] storage token 발급 사용자에 `Connectivity Directory Bind` account member
      role 부여
- [ ] D1 migration API token 발급: Account `D1: Edit`

세 API token은 각각 발급하고 대상 account/resource만 허용합니다. storage
배포에 Admin role은 필요하지 않습니다.

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
- [ ] `IMAGE_ORIGIN=https://<IMAGE_DOMAIN>`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_REDIRECT_URI=https://<APP_DOMAIN>/auth/callback`
- [ ] `GOOGLE_ALLOWED_EMAILS`

Cloudflare web Worker encrypted secrets:

- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `AUTH_SESSION_SECRET`

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

## 4. 배포 순서

- [ ] `ORIGIN_ADMIN_TOKEN`과 origin mutation token 일치 확인
- [ ] `Deploy storage Worker`
- [ ] storage Custom Domain 연결
- [ ] `Migrate D1`
- [ ] `Deploy web Worker`
- [ ] web Custom Domain 연결
- [ ] 인증 없는 브라우저가 Google 인증 화면으로 이동하는지 확인
- [ ] 허용 계정으로 web 화면, 업로드, 검색, 캐시 HIT, 삭제 후 404 확인
- [ ] 허용목록 밖의 Google 계정이 차단되는지 확인
