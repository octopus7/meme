# meme-origin

**한국어** | [English](README.md)

Meme 서비스의 private Node.js 이미지 origin입니다. `sharp`로 JPEG, PNG, WebP,
GIF 업로드를 검증하고 SHA-256 기준으로 원본을 저장하며 자동 회전·중앙 crop된
128×128 WebP 썸네일을 생성합니다. J1900 환경을 고려해 이미지 처리는 기본적으로
직렬화됩니다.

## Synology Container Manager

지원 런타임은 Debian Bookworm 기반 Node.js 24입니다. DSM 자체의 오래된 라이브러리와
Node 패키지에 의존하지 않도록 Container Manager를 사용합니다.

```sh
cd /volume1/docker/meme-origin
cp .env.example .env
openssl rand -hex 32
vi .env
chmod 0600 .env
mkdir -p data logs
```

mutation token을 32자 이상의 무작위 값으로 바꾸고 `data`, `logs`를 소유한 DSM
사용자의 `PUID`와 `PGID`를 설정합니다. Container Manager에서 **Project → Create**를
선택하고 `/volume1/docker/meme-origin/compose.yaml`을 build/start합니다.

프로젝트는 다음을 제공합니다.

- `node:24-bookworm-slim`
- `127.0.0.1:8086` host binding
- 영속 `data/`, `logs/` bind mount
- `restart: unless-stopped`
- application health check
- read-only filesystem, capability 제거, private `/tmp`

Cloudflare Tunnel은 `http://127.0.0.1:8086`에 접근합니다. 공개 이미지 hostname과
Access 보호 admin hostname은 이 로컬 서비스로 연결할 수 있지만, router port
forwarding으로 mutation API를 직접 공개하지 않습니다.

### GitHub에서 설치·업데이트

Git 없이 공개 GitHub archive에서 `origin/`만 설치하거나 업데이트합니다.

```sh
curl --fail --location --output /tmp/deploy-latest-from-github.sh \
  https://raw.githubusercontent.com/octopus7/meme/main/origin/docker/deploy-latest-from-github.sh
```

표준 Synology 경로에 배포합니다.

```sh
sh /tmp/deploy-latest-from-github.sh \
  --repo octopus7/meme \
  --ref main \
  --target /volume1/docker/meme-origin
```

스크립트는 최신 `main` 커밋 SHA를 기록하고 Docker 이미지를 build/recreate한 뒤
`/healthz`가 응답할 때까지 기다립니다. `.env`, `data/`, `logs/`는 유지하고 기존
애플리케이션 파일은 `backups/`에 보관합니다.

## API

Cloudflare Tunnel 이미지 hostname을 통한 공개 읽기:

```text
GET|HEAD /i/{sha256}.{jpg|png|webp|gif}
GET|HEAD /t/{sha256}
GET      /healthz  {"status":"ok","commit":"<sha>"}
```

`/internal/*` endpoint는 Access 보호 admin hostname 전용입니다. 공개 이미지
hostname에는 `/i/*`, `/t/*`의 GET/HEAD만 허용하고 `/internal/*`, `/healthz`, 쓰기
method는 차단합니다. web Worker는 admin hostname 호출 시 Cloudflare Access service
token과 origin bearer token을 모두 보내야 합니다.

Media는 ETag, If-None-Match, If-Modified-Since와 단일 byte range를 지원합니다.
mutation에는 `Authorization: Bearer <token>`이 필요합니다.

```text
POST /internal/v1/blobs                    raw image body
POST /internal/v1/blobs/{sha256}/trash
POST /internal/v1/blobs/{sha256}/restore
POST /internal/v1/admin/purge
```

모든 health 이외 요청은 `logs/access-YYYY-MM-DD.log`에 한 줄 JSON으로 기록합니다.
Authorization, query string, body와 token은 기록하지 않습니다. 30일이 지난 로그는
`.log.gz`로 압축됩니다.

## 로컬 검증

Docker 외부에서는 Node.js `>=24 <25`가 필요합니다.

```sh
cd origin
npm ci
npm test
docker compose config
docker compose build
```

환경 설정은 `.env.example`를 참고합니다. `.env`, token, `node_modules`, 저장 이미지와
로그는 커밋하지 않습니다.
