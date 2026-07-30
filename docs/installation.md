# 설치 순서

이 문서는 최초 운영 환경을 만드는 순서를 설명합니다. 모든 `<PLACEHOLDER>`는
운영자가 직접 만든 값으로 바꾸되 저장소에는 기록하지 않습니다.

## 준비 사항

- Cloudflare에 연결된 도메인
- Google 계정과 Cloudflare Zero Trust 사용 권한
- GitHub Actions가 활성화된 이 저장소
- x86-64 Synology/XPEnology의 Container Manager(Docker) 또는 .NET 10 실행 환경
- Linux 서버에서 외부 Cloudflare로 나가는 HTTPS 연결
- origin 데이터 디렉터리를 위한 충분한 디스크와 별도 백업

권장 호스트 분리는 다음과 같습니다.

```text
app.example.com  인증 웹 Worker
img.example.com  공개 이미지 Worker
```

`img.example.com`은 URL을 아는 누구나 접근할 수 있으므로 주소 자체를 비밀로
간주하면 안 됩니다. 업로드·삭제·관리 API는 공개 이미지 경로와 분리됩니다.

## 1. Linux origin 선택 및 설치

동일한 URI와 JSON 계약을 제공하는 구현 중 하나를 선택합니다.

- [Node.js 24 Docker origin 설치](origin.md): Container Manager project, 기본
  `127.0.0.1:8086`
- [.NET 10 origin 설치](origin-dotnet.md): `meme-origin-dotnet.service`, 기본
  `127.0.0.1:8087`

두 서비스는 계정, 포트와 데이터 디렉터리가 분리되어 같은 장비에서 동시에 실행할
수 있습니다. 8086과 8087용 VPC Service를 각각 준비한 뒤 실제 storage Worker는
선택한 하나의 `VPC_SERVICE_ID`만 바인딩합니다.
어느 구현이든 loopback 또는 Tunnel이 도달할 수 있는 사설 주소에서만 수신하게
하고 라우터의 포트 포워딩은 만들지 않습니다.

Synology에서는 DSM에 Node를 직접 설치하지 않고 Debian Bookworm 기반 Node.js 24
LTS 컨테이너를 사용합니다. 설치 소스는
`https://github.com/octopus7/meme`의 `origin/`이며 실제 `.env`와 token은 NAS에만
둡니다. Container Manager를 사용할 수 없다면 .NET 10 self-contained origin이나
Node systemd fallback의 적합성을 별도로 검토합니다.

선택한 서비스가 정상인지 Linux 서버에서 확인합니다.

```bash
# Node.js origin
curl --fail http://127.0.0.1:8086/healthz

# .NET 10 origin
curl --fail http://127.0.0.1:8087/healthz
```

## 2. Tunnel과 VPC Service 생성

[Cloudflare 인프라 설정](cloudflare.md)의 순서대로 Workers VPC 대시보드에서
Tunnel을 만들고, Cloudflare가 표시한 설치 명령으로 `cloudflared`를 서비스로
등록합니다. Tunnel 토큰은 Linux의 systemd 자격 증명 또는 Cloudflare 설치
절차에만 사용하고 GitHub에는 저장하지 않습니다.

같은 Tunnel에 Node 8086용 HTTP VPC Service와 .NET 8087용 HTTP VPC Service를
각각 만듭니다. VPC Service는 등록된 포트를 강제하므로 구현을 전환할 때 선택한
Service ID를 GitHub `storage-production` Environment의 `VPC_SERVICE_ID`에 넣고
그에 맞는 `ORIGIN_BASE_URL`도 함께 바꿉니다.

## 3. D1 생성

Cloudflare 대시보드 또는 로컬에서 인증한 Wrangler로 D1 데이터베이스를 한 번
생성합니다.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

데이터베이스 이름과 ID를 GitHub `web-production` Environment 변수에 등록하고,
[D1 migration 워크플로](github-actions.md#d1-migration)를 수동 실행합니다.

## 4. Worker 최초 배포

GitHub Actions에서 다음 순서로 실행합니다.

1. `Deploy storage Worker`
2. Cloudflare 대시보드에서 storage Worker에 `img.example.com` Custom Domain 연결
3. `Migrate D1`
4. `Deploy web Worker`
5. Cloudflare 대시보드에서 web Worker에 `app.example.com` Custom Domain 연결

Worker의 Custom Domain과 Route는 대시보드에서 관리합니다. 도메인·zone ID를
Wrangler 파일에 커밋하지 않습니다.

## 5. Access 적용

[Access와 Google 로그인](cloudflare-access.md)을 따라 `app.example.com/*`에만
Access를 적용합니다. `img.example.com`에는 Access 정책을 적용하지 않습니다.
정상 로그인 후 앱의 `/` 응답이 `/search`로 이동하는지 확인합니다.

## 6. 점검

로그인하지 않은 브라우저와 로그인한 브라우저를 분리해 확인합니다.

- `app.example.com`은 Google 로그인 없이는 열리지 않는다.
- 허용 목록에 없는 Google 계정은 거부된다.
- `/search`의 빈 입력은 이미지 요청이나 검색 API 호출을 만들지 않는다.
- 검색 입력 중 결과가 최대 5개만 나타난다.
- `/all`은 현재 로그인 사용자의 항목만 표시한다.
- 같은 파일을 두 번 올려도 origin의 원본 파일 수가 늘지 않는다.
- `img.example.com/i/...`와 `/t/...`는 로그인 없이 열리고 `HEAD`가 동작한다.
- 두 번째 이미지 요청의 `Cf-Cache-Status`가 `HIT`이며 origin access log가 늘지 않는다.
- 마지막 참조 삭제 및 purge 완료 후 두 이미지 URL이 404가 된다.

실서비스 전에는 업로드 중 장애, D1 실패, Tunnel 중단, 디스크 부족과 30일 purge를
별도의 시험 데이터로 검증합니다.
