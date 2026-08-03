# Node.js 24 Docker origin 설치

**한국어** | [English](origin.md)

Node origin은 Node.js 24 LTS와 `sharp`로 이미지를 처리합니다. Synology/XPEnology에서는
DSM에 Node.js와 native 라이브러리를 직접 설치하는 방식보다 **Container Manager
(Docker)** 사용을 권장합니다. 컨테이너는 Debian Bookworm 기반
`node:24-bookworm-slim`을 사용하고 외부에는 loopback `8086`만 엽니다.

## 권장 환경

- x86-64 Synology/XPEnology와 Container Manager 또는 Docker Compose
- `/volume1/docker/meme-origin`에 대한 읽기·쓰기 권한
- 데이터와 로그를 위한 별도 백업
- `img.example.com` 및 `origin-admin.example.com` Cloudflare Tunnel route

지원 런타임은 Docker 이미지 안의 Node.js 24 LTS입니다. 빌드·테스트와 실행이 DSM
자체 Node 버전에 의존하지 않습니다.

## GitHub에서 설치·업데이트

Git 없이 공개 GitHub archive에서 `origin/`만 설치하거나 업데이트할 수 있습니다.

```bash
curl --fail --location --output /tmp/deploy-latest-from-github.sh \
  https://raw.githubusercontent.com/octopus7/meme/main/origin/docker/deploy-latest-from-github.sh
```

기본 대상은 `/volume1/docker/meme-origin`입니다. 최신 `main` 커밋 SHA를 기록하고
Docker 이미지를 build/recreate한 뒤 `/healthz`가 응답할 때까지 기다립니다.

```bash
sh /tmp/deploy-latest-from-github.sh \
  --repo octopus7/meme \
  --ref main \
  --target /volume1/docker/meme-origin
```

`.env`, `data/`, `logs/`는 보존하고 기존 애플리케이션 파일은 `backups/`에 남깁니다.
Worker 배포나 D1 migration은 실행하지 않습니다.

## Container Manager 프로젝트 생성

수동 최초 설치가 필요하면 다음을 실행합니다.

```bash
cd /volume1/docker/meme-origin
cp .env.example .env
openssl rand -hex 32
vi .env
chmod 0600 .env
mkdir -p data logs
```

`.env`에서 mutation token을 32자 이상의 무작위 값으로 교체하고, `data/`와 `logs/`
소유자의 `PUID`·`PGID`, `MEME_HOST_ROOT=/volume1/docker/meme-origin`을 확인합니다.
같은 mutation token을 web Worker secret `ORIGIN_ADMIN_TOKEN`에 등록합니다.

Container Manager에서 **Project → Create**를 선택하고 `/volume1/docker/meme-origin`을
프로젝트 경로로 지정한 뒤 `compose.yaml`을 build/start합니다.

```bash
curl --fail http://127.0.0.1:8086/healthz
```

응답에는 배포된 커밋 SHA가 포함됩니다.

```json
{"status":"ok","commit":"ddf849ab7026bcecf7b9ac5eb468a2b1fd086f03"}
```

라우터 port forwarding으로 8086이나 mutation API를 인터넷에 공개하지 않습니다.
공개 이미지 hostname에는 `/i/*`, `/t/*`의 GET/HEAD만 연결하고 `/internal/*`와
`/healthz`는 차단합니다. 관리 요청은 `origin-admin.example.com`으로 전달하되
Bearer mutation token을 반드시 사용합니다.

## 업데이트와 rollback

업데이트할 때는 `deploy-latest-from-github.sh`를 다시 실행합니다. 기존 애플리케이션
파일을 백업한 뒤 교체하며 `.env`, `data/`, `logs/`는 보존합니다. 새 컨테이너가
health check에 실패하면 `backups/`의 이전 애플리케이션 파일을 복구해 다시 build합니다.
데이터와 환경 파일은 별도 백업 결정 없이 삭제하거나 rollback하지 않습니다.

## 운영 점검

- Container Manager health, restart 횟수와 image build 실패를 감시합니다.
- `/healthz`를 제외한 요청의 `logs/access-YYYY-MM-DD.log`에 Authorization, query,
  body와 token이 없는지 확인합니다.
- 기본 하루 1회 trash purge와 30일 지난 access log 압축을 점검합니다.
- `data/`의 원본·thumbnail·trash와 `.env`를 별도 백업합니다.
- `data/`, `logs/` 소유권을 바꿀 때 `PUID`/`PGID`도 함께 검증합니다.
- Docker image와 Node.js 24 LTS 보안 업데이트를 정기적으로 rebuild합니다.
