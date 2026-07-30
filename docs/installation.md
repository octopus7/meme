# 설치 순서

이 문서는 최초 운영 환경을 만드는 순서를 설명합니다. 모든 `<PLACEHOLDER>`는
운영자가 직접 만든 값으로 바꾸되 저장소에는 기록하지 않습니다.

## 준비 사항

- Cloudflare에 연결된 도메인
- GitHub Actions가 활성화된 이 저장소
- x86-64 Synology/XPEnology의 Container Manager(Docker)
- Linux 서버에서 외부 Cloudflare로 나가는 HTTPS 연결
- origin 데이터 디렉터리를 위한 충분한 디스크와 별도 백업

권장 호스트 분리는 다음과 같습니다.

```text
app.example.com  Google 인증 웹 Worker
img.example.com  공개 이미지 Worker
```

`img.example.com`은 URL을 아는 누구나 접근할 수 있으므로 주소 자체를 비밀로
간주하면 안 됩니다. 업로드·삭제·관리 API는 공개 이미지 경로와 분리됩니다.

## 1. Linux origin 설치

- [Node.js 24 Docker origin 설치](origin.md): Container Manager project, 기본
  `127.0.0.1:8086`

서비스는 loopback 또는 Tunnel이 도달할 수 있는 사설 주소에서만 수신하게
하고 라우터의 포트 포워딩은 만들지 않습니다.

Synology에서는 DSM에 Node를 직접 설치하지 않고 Debian Bookworm 기반 Node.js 24
LTS 컨테이너를 사용합니다. 설치 소스는
`https://github.com/octopus7/meme`의 `origin/`이며 실제 `.env`와 token은 NAS에만
둡니다. Container Manager를 사용할 수 없다면 Node systemd fallback의 적합성을
별도로 검토합니다.

서비스가 정상인지 Linux 서버에서 확인합니다.

```bash
# Node.js origin
curl --fail http://127.0.0.1:8086/healthz
```

## 2. Tunnel과 VPC Service 생성

[Cloudflare 인프라 설정](cloudflare.md)의 순서대로 Workers VPC 대시보드에서
Tunnel을 만들고, Cloudflare가 표시한 설치 명령으로 `cloudflared`를 서비스로
등록합니다. Tunnel 토큰은 Linux의 systemd 자격 증명 또는 Cloudflare 설치
절차에만 사용하고 GitHub에는 저장하지 않습니다.

같은 Tunnel에 Node 8086용 HTTP VPC Service를 만듭니다. Service ID를 GitHub
`storage-production` Environment의 `VPC_SERVICE_ID`에 넣고 Node origin의 내부
URL을 `ORIGIN_BASE_URL`에 설정합니다.

## 3. D1 생성

Cloudflare 대시보드 또는 로컬에서 인증한 Wrangler로 D1 데이터베이스를 한 번
생성합니다.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

데이터베이스 이름과 ID를 GitHub `web-production`, `storage-production`
Environment 변수에 등록하고,
[D1 migration 워크플로](github-actions.md#d1-migration)를 수동 실행합니다.

## 4. Worker 최초 배포

GitHub Actions에서 다음 순서로 실행합니다.

1. `Migrate D1`
2. `Deploy storage Worker`
3. Cloudflare 대시보드에서 storage Worker에 `img.example.com` Custom Domain 연결
4. `Deploy web Worker`
5. Cloudflare 대시보드에서 web Worker에 `app.example.com` Custom Domain 연결

Worker의 Custom Domain과 Route는 대시보드에서 관리합니다. 도메인·zone ID를
Wrangler 파일에 커밋하지 않습니다.

## 5. 도메인과 Google 인증 확인

`app.example.com`은 Google 인증을 요구하고 `img.example.com`의 이미지 읽기
경로는 공개합니다. `docs/google-oauth.md`에 따라 Google OAuth redirect URI와
Worker secret을 먼저 설정합니다.

## 6. 점검

- 비공개 브라우저 창에서 `app.example.com`을 열면 Google 인증 화면으로 이동한다.
- 관리자 Google 계정으로 로그인한 뒤 `/`가 `/search`로 이동한다.
- 관리자 화면에서 외부 회원을 차단하면 일반 Google 계정은 세션을 사용할 수 없다.
- 일반 회원의 `/all`에는 관리자 톱니가 없고 `/admin`, `/logs`는 404다.
- `/search`의 빈 입력은 이미지 요청이나 검색 API 호출을 만들지 않는다.
- 검색 입력 중 결과가 최대 5개만 나타난다.
- `/all`은 전체 항목을 표시한다.
- 같은 파일을 두 번 올려도 origin의 원본 파일 수가 늘지 않는다.
- `img.example.com/i/...`와 `/t/...`는 인증 없이 열리고 `HEAD`가 동작한다.
- 두 번째 이미지 요청의 `Cf-Cache-Status`가 `HIT`이며 origin access log가 늘지 않는다.
- 관리자 통계에서 요청 목록과 지정 구간의 파일별 HIT율이 표시된다.
- 마지막 참조 삭제 및 purge 완료 후 두 이미지 URL이 404가 된다.

실서비스 전에는 업로드 중 장애, D1 실패, Tunnel 중단, 디스크 부족과 30일 purge를
별도의 시험 데이터로 검증합니다.
