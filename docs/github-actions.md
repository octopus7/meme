# GitHub Actions 설정과 배포 격리

GitHub repository의 **Settings → Environments**에서 다음 Environment를 각각
만듭니다.

```text
web-production
storage-production
d1-production
```

운영 배포 Environment에는 required reviewer와 main branch protection을
권장합니다. Linux 서버용 SSH key는 어느 Worker Environment에도 넣지 않습니다.

## Environment 값

### web-production

| 종류 | 이름 | 내용 |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | web Worker 배포만 가능한 최소 권한 token |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `WEB_WORKER_NAME` | web Worker script 이름 |
| variable | `D1_DATABASE_NAME` | D1 표시 이름 |
| variable | `D1_DATABASE_ID` | D1 database ID |
| variable | `STORAGE_WORKER_NAME` | service binding 대상 Worker 이름 |
| variable | `IMAGE_ORIGIN` | 공개 이미지 origin, 예: `https://img.example.com` |

### storage-production

| 종류 | 이름 | 내용 |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | storage Worker 배포와 VPC bind 최소 권한 token |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `STORAGE_WORKER_NAME` | 공개 storage Worker script 이름 |
| variable | `D1_DATABASE_NAME` | web Worker와 같은 요청 로그 D1 이름 |
| variable | `D1_DATABASE_ID` | web Worker와 같은 요청 로그 D1 ID |
| variable | `VPC_SERVICE_ID` | 기존 HTTP VPC Service ID |
| variable | `ORIGIN_BASE_URL` | Node VPC origin URL, 예: `http://meme-origin.internal:8086` |

### d1-production

| 종류 | 이름 | 내용 |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | 해당 D1에 migration 가능한 최소 권한 token |
| variable | `CF_ACCOUNT_ID` | Cloudflare account ID |
| variable | `D1_DATABASE_NAME` | migration 대상 D1 이름 |
| variable | `D1_DATABASE_ID` | migration 대상 D1 ID |

account ID와 resource ID는 비밀 credential은 아니지만 계정 정보가 저장소에
고정되지 않도록 GitHub variables로 관리합니다. API token은 반드시 secret으로
관리합니다. Workers VPC용 Tunnel token은 GitHub에 둘 필요가 없습니다.

## Token 최소 권한

각 token의 resource scope를 운영 account 하나로 제한합니다. 현재 D1 token은
특정 database 하나가 아니라 account 단위로 제한되므로 migration 전용 token으로
분리합니다.

- `web-production`: Account → Workers Scripts → Edit
- `storage-production`: Account → Workers Scripts → Edit. 또한 token을 발급하는
  계정 구성원에게 기존 VPC Service를 binding할 수 있는
  `Connectivity Directory Bind` account member role이 필요합니다. Admin role은
  필요하지 않습니다.
- `d1-production`: Account → D1 → Edit

Cloudflare 권한 이름은 변경될 수 있으므로 token 생성 화면의 현재 명칭과
[Workers VPC required roles](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#required-roles)를
확인합니다. 세 token을 각각 발급하고, 하나의 광범위한 Global API Key나 token을
세 Environment에서 공유하지 않습니다.

공식 참고:

- [API token 생성](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [API token 권한 목록](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

## Workflow별 영향 범위

| Workflow | trigger | 변경 대상 |
|---|---|---|
| `Deploy web Worker` | `workers/web/**` push 또는 수동 | web Worker만 |
| `Deploy storage Worker` | `workers/storage/**` push 또는 수동 | storage Worker만 |
| `Build origin` | `origin/**` push/PR 또는 수동 | Node.js 24 Docker 검증 및 Linux x64 GitHub artifact만 |
| `Migrate D1` | 수동 | D1 schema만 |

각 deploy job은 자기 디렉터리에서만 `npm ci`와 Wrangler를 실행합니다. 런타임에
`.wrangler.generated.jsonc`를 만들고 종료 시 삭제합니다. 해당 파일은 `.gitignore`에도
포함되어 있습니다. 배포 command의 `--keep-vars`는 Cloudflare 대시보드에서
관리하는 런타임 secret/variable을 보존합니다.

Custom Domain, Workers VPC용 Tunnel과 VPC Service 생성은 workflow가 변경하지
않습니다.
Worker 배포가 Linux 파일을 복사·삭제하거나 서비스를 재시작하는 단계도 없습니다.
origin build는 Node.js 24에서 `npm ci`, test, Linux x64용 `sharp` 0.35.3 로드와
Docker image build를 검증합니다. artifact에는 Container Manager와 systemd
fallback 파일이 포함되지만 서버 접속 credential은 사용하지 않습니다.

origin workflow는 artifact만 생성하며 서버에 접속하거나 Worker 또는 D1을
변경하지 않습니다.

## D1 migration

`Migrate D1`은 `workflow_dispatch`만 허용하며 `d1-production` 승인을 거칩니다.
실행 전에 Cloudflare D1 export 등 운영 정책에 맞는 backup을 확보합니다.
migration은 되돌릴 수 있는 additive 변경을 우선하고, Worker와 호환되지 않는
column/table 제거는 별도 release로 나눕니다.

권장 배포 순서:

```text
additive D1 migration
→ storage Worker
→ web Worker
→ smoke test
→ 후속 정리 migration
```

## Runtime secret

storage Worker에는 Cloudflare 대시보드에서 `ORIGIN_ADMIN_TOKEN`을 encrypted
secret으로 등록합니다. 값은 Node origin의 `MEME_ORIGIN_MUTATION_TOKEN`과
같아야 하며 32자 이상의 무작위 값이어야 합니다. 배포 workflow는 `wrangler secret put`을
자동 실행하지 않으므로 secret 값이 로그나 임시 config에 들어가지 않습니다.
`ORIGIN_ADMIN_TOKEN`은 GitHub Environment에는 등록하지 않습니다.
