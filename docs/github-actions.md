# GitHub Actions 설정과 배포 격리

현재 구성에서는 storage Worker와 Workers VPC 배포가 없습니다. GitHub repository의
**Settings → Environments**에서 다음 Environment만 운영용으로 만듭니다.

```text
web-production
d1-production
```

`Build origin`은 서버에 배포하지 않고 Docker 검증 artifact만 생성합니다. 운영
배포 Environment에는 required reviewer와 main branch protection을 권장합니다.
Linux 서버용 SSH key와 Tunnel token은 어느 Worker Environment에도 넣지 않습니다.

## Environment 값

### web-production

| 종류 | 이름 | 내용 |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | web Worker 배포만 가능한 최소 권한 token |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `WEB_WORKER_NAME` | web Worker script 이름 |
| variable | `D1_DATABASE_NAME` | D1 표시 이름 |
| variable | `D1_DATABASE_ID` | D1 database ID |
| variable | `IMAGE_ORIGIN` | 공개 이미지 origin, 예: `https://img.example.com` |
| variable | `ORIGIN_ADMIN_BASE_URL` | Bearer token으로 보호하는 관리 hostname, 예: `https://origin-admin.example.com` |
| variable | `CF_ZONE_ID` | 이미지 Zone ID |
| variable | `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| variable | `GOOGLE_REDIRECT_URI` | `https://<APP_DOMAIN>/auth/callback` |
| variable | `GOOGLE_ALLOWED_EMAILS` | 관리자 이메일 하나 |

Cloudflare web Worker encrypted secrets:

| 이름 | 내용 |
|---|---|
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret |
| `AUTH_SESSION_SECRET` | 세션 서명용 무작위 secret |
| `ORIGIN_ADMIN_TOKEN` | origin `MEME_ORIGIN_MUTATION_TOKEN`과 동일한 bearer token |
| `CF_CACHE_PURGE_TOKEN` | 대상 Zone의 Cache Purge만 허용하는 API token |

`ORIGIN_ADMIN_TOKEN`, purge token은 GitHub 변수로 만들지 않습니다.
배포 workflow는 secret을 출력하거나 `wrangler secret put`으로 덮어쓰지 않고,
Cloudflare Worker Settings에 등록된 값을 `--keep-vars`로 보존합니다.

### d1-production

| 종류 | 이름 | 내용 |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | 해당 D1에 migration 가능한 최소 권한 token |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `D1_DATABASE_NAME` | migration 대상 D1 이름 |
| variable | `D1_DATABASE_ID` | migration 대상 D1 ID |

account ID와 resource ID는 비밀 credential은 아니지만 저장소에 고정하지 않도록
GitHub variables로 관리합니다. API token은 반드시 secret으로 관리합니다.

## Token 최소 권한

각 token의 resource scope를 운영 account와 필요한 Zone/database로 제한합니다.

- `web-production`: Account → Workers Scripts → Edit
- `web-production`의 `CF_CACHE_PURGE_TOKEN`: 대상 Zone → Cache Purge → Purge by
  cache-tag만 허용
- `d1-production`: Account → D1 → Edit

Tunnel connector token은 Cloudflare 대시보드와 Synology에만 설정합니다. Workers
VPC의 `Connectivity Directory Bind`, VPC Service ID, storage Worker용 배포 token은
더 이상 필요하지 않습니다.

공식 참고:

- [API token 생성](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [API token 권한 목록](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cache purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)

## Workflow별 영향 범위

| Workflow | trigger | 변경 대상 |
|---|---|---|
| `Deploy web Worker` | `workers/web/**` push 또는 수동 | web Worker만 |
| `Build origin` | `origin/**` push/PR 또는 수동 | Node.js 24 Docker 검증 및 Linux x64 artifact만 |
| `Migrate D1` | 수동 | D1 schema만 |

`Deploy storage Worker` workflow와 `render-storage-wrangler.mjs`는 제거합니다.
각 deploy job은 자기 디렉터리에서만 `npm ci`와 Wrangler를 실행하며, 런타임에
`.wrangler.generated.jsonc`를 만들고 종료 시 삭제합니다. 해당 파일은 `.gitignore`에도
포함되어 있습니다.

Custom Domain, Tunnel route와 Cache Rule 생성은
workflow가 변경하지 않습니다. Cloudflare 대시보드에서 먼저 만들고 smoke test로
확인합니다. Worker 배포가 Linux 파일을 복사·삭제하거나 서비스를 재시작하는
단계도 없습니다.

origin workflow는 Node.js 24에서 `npm ci`, test, Linux x64용 `sharp` 로드와 Docker
image build를 검증하고 artifact만 생성합니다. 서버 접속 credential은 사용하지
않습니다.

## D1 migration

`Migrate D1`은 `workflow_dispatch`만 허용하며 `d1-production` 승인을 거칩니다.
실행 전에 Cloudflare D1 export 등 운영 정책에 맞는 backup을 확보합니다.
migration은 되돌릴 수 있는 additive 변경을 우선하고, Worker와 호환되지 않는
column/table 제거는 별도 release로 나눕니다.

권장 배포 순서:

```text
additive D1 migration
→ web Worker
→ smoke test (Tunnel, CDN cache, purge, exposure log)
→ 후속 정리 migration
```

`image_url_exposure_logs`는 web Worker가 `/all`·`/search` HTML에 이미지 URL을
포함한 시점을 기록하는 테이블입니다. 실제 브라우저 다운로드나 CDN HIT를 의미하지
않으며, 90일 보존 후 web Worker cron이 bounded batch로 정리합니다.

## Runtime secret 점검

배포 전에 다음을 확인합니다.

1. `ORIGIN_ADMIN_BASE_URL`이 `https://`이고 관리 hostname을 가리킵니다.
2. `ORIGIN_ADMIN_TOKEN`이 origin의 mutation token과 일치합니다.
3. `CF_ZONE_ID`가 `IMAGE_ORIGIN`의 Zone이고, purge token이 해당 Zone의 tag purge만
   수행할 수 있습니다.
4. secret 값이 workflow 로그, generated Wrangler 파일, 커밋에 나타나지 않습니다.
