# Node.js 24 Docker origin 설치

Node origin은 Node.js 24 LTS와 `sharp`로 이미지를 처리합니다. Synology/XPEnology에서는
DSM에 Node.js와 native 라이브러리를 직접 설치하는 방식보다 **Container Manager
(Docker)** 사용을 권장합니다. 컨테이너는 Debian Bookworm 기반
`node:24-bookworm-slim`을 사용하고 외부에는 loopback `8086`만 엽니다.

## 권장 환경

- x86-64 Synology/XPEnology와 Container Manager 또는 Docker Compose
- `/volume1/docker/meme-origin`에 대한 읽기·쓰기 권한
- 데이터와 로그를 위한 별도 백업
- Cloudflare Tunnel의 `img.example.com` 및 `origin-admin.example.com` route가
  `http://127.0.0.1:8086`에 접근할 수 있는 구성

지원 런타임은 Docker 이미지 안의 Node.js 24 LTS입니다. 빌드·테스트와 실행이
DSM 자체 Node 버전에 의존하지 않습니다.

## GitHub에서 설치 파일 받기

Git 없이 공개 GitHub archive에서 `origin/`만 설치하거나 업데이트할 수 있습니다.

```bash
curl --fail --location --output /tmp/install-meme-origin.sh \
  https://raw.githubusercontent.com/octopus7/meme/main/origin/docker/install-from-github.sh
sh /tmp/install-meme-origin.sh
```

기본 대상은 `/volume1/docker/meme-origin`입니다. 다른 volume을 쓰려면 명시합니다.

```bash
sh /tmp/install-meme-origin.sh \
  --repo octopus7/meme \
  --ref main \
  --target /volume1/docker/meme-origin
```

스크립트는 저장소 전체를 배포하지 않고 `origin/`만 교체합니다. 최초 실행 시
`.env`를 만들고, 업데이트 시 `.env`, `data/`, `logs/`를 보존하며 이전 애플리케이션
파일은 `backups/`에 남깁니다. Worker를 배포하거나 D1 migration을 실행하지 않습니다.

## Container Manager 프로젝트 생성

설치 디렉터리에서 환경 파일과 영속 디렉터리를 준비합니다.

```bash
cd /volume1/docker/meme-origin
cp .env.example .env
openssl rand -hex 32
vi .env
chmod 0600 .env
mkdir -p data logs
```

`.env`에서 다음을 확인합니다.

- mutation token을 32자 이상의 무작위 값으로 교체
- `PUID`와 `PGID`를 `data/`, `logs/` 소유 DSM 사용자 값으로 설정
- `MEME_HOST_ROOT=/volume1/docker/meme-origin`

같은 mutation token을 web Worker의 Cloudflare encrypted secret
`ORIGIN_ADMIN_TOKEN`에 등록합니다. `origin-admin.example.com`은 Cloudflare
Access Service Auth 뒤에 두고, web Worker가 Access service token과 이 mutation
token을 모두 보냅니다. 실제 `.env`, token, 이미지와 로그는 커밋하지 않습니다.

Synology Container Manager에서:

1. **Project → Create**를 선택합니다.
2. project 경로를 `/volume1/docker/meme-origin`으로 지정합니다.
3. `compose.yaml`을 선택해 build하고 시작합니다.
4. 컨테이너 health 상태와 아래 endpoint를 확인합니다.

```bash
curl --fail http://127.0.0.1:8086/healthz
```

Compose 구성은 다음 안전 경계를 적용합니다.

- host binding `127.0.0.1:8086`
- `data/`와 `logs/`만 영속 bind mount
- read-only container filesystem과 private `/tmp`
- Linux capabilities 제거와 `no-new-privileges`
- `restart: unless-stopped` 및 application health check

라우터 port forwarding으로 8086이나 mutation API를 인터넷에 공개하지 않습니다.
공개 이미지 hostname에는 `/i/*`, `/t/*`의 GET/HEAD만 연결하고
`/internal/*`와 `/healthz`는 차단합니다. 관리 요청은 Access 보호
`origin-admin.example.com`을 통해서만 도달해야 합니다.

## 업데이트

동일한 설치 스크립트를 다시 실행한 뒤 Container Manager에서 project의
**Build**와 **Recreate**를 수행합니다.

```bash
sh /tmp/install-meme-origin.sh
```

업데이트 전 `data/`, `.env`와 로그를 백업합니다. 새 컨테이너 health check가
실패하면 `backups/`의 이전 애플리케이션 파일을 복구해 다시 build합니다. 데이터와
환경 파일은 rollback하거나 삭제하지 않습니다.

## GitHub Actions artifact

`Build origin` workflow는 Node.js 24에서 test와 Docker build를 검증하고
`meme-origin-node24-linux-x64-<commit>` artifact를 만듭니다. artifact에는
Container Manager 파일과 Linux x64 애플리케이션 의존성이 포함되지만 실제
환경 파일이나 token은 없습니다.

이 workflow는 artifact만 생성하며 NAS에 접속하거나 서버, Worker 또는 D1을
변경하지 않습니다. 비컨테이너 systemd 설치가 꼭 필요한 경우에는
[origin README](../origin/README.md)의 fallback 절차를 사용하되 Synology에서는
Container Manager를 우선합니다.

## 운영 점검

- Container Manager health, restart 횟수와 image build 실패를 감시합니다.
- `/healthz`를 제외한 요청이 기록되는 `logs/access-YYYY-MM-DD.log`에
  Authorization, query, body와 token이 없는지 확인합니다.
- 만료된 trash 검사는 기본적으로 하루에 한 번 실행됩니다
  (`MEME_ORIGIN_PURGE_INTERVAL=1d`).
- 30일이 지난 access log의 gzip 압축과 trash purge를 점검합니다.
- `data/`의 원본·thumbnail·trash와 `.env`를 별도 백업합니다.
- `data/`, `logs/` 소유권을 바꿀 때 `PUID`/`PGID`도 함께 검증합니다.
- Docker image와 Node.js 24 LTS 보안 업데이트를 정기적으로 rebuild해 반영합니다.
