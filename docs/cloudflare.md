# Cloudflare 인프라

계정별 값은 Cloudflare 대시보드와 GitHub Environment에만 둡니다. 이 저장소에는
실제 도메인, account/zone/database/service ID 또는 API token을 기록하지 않습니다.

## D1

D1에는 물리 blob과 컬렉션 항목 참조를 구분해 저장합니다. migration의 기준 원본은
`database/d1/migrations`이며, 운영 migration은 자동 Worker 배포와 분리된 수동
워크플로만 적용합니다.

```text
blob: SHA-256, canonical extension, MIME, size, active/trashed 상태
item: 내부 소유자 식별값, blob hash, 설명, 원래 파일명, 생성/삭제 시각
```

원래 파일명은 검색 대상이지만 검색 결과 화면이나 API 응답에는 표시하지 않습니다.
설명에서 일치한 문구만 안전하게 escape한 뒤 `<mark>`로 강조합니다.

데이터베이스 생성은 한 번만 수행합니다.

```bash
npx wrangler@latest d1 create <D1_DATABASE_NAME>
```

반환된 ID를 `web-production` Environment의 `D1_DATABASE_ID`에 저장합니다.

## Workers VPC와 Tunnel

Workers VPC는 현재 beta일 수 있으므로 배포 전에
[Workers VPC 문서](https://developers.cloudflare.com/workers-vpc/get-started/)의
현재 제한과 권한을 확인합니다.

1. Cloudflare 대시보드의 **Workers VPC → Tunnels**에서 Tunnel을 생성합니다.
2. 대시보드가 Linux amd64용으로 표시한 명령으로 `cloudflared`를 설치합니다.
3. Tunnel 상태가 healthy인지 확인합니다.
4. **VPC Services → Create**에서 HTTP 서비스를 만듭니다.
5. Node `8086`용 HTTP VPC Service를 만듭니다.
6. Service ID를 GitHub 변수 `VPC_SERVICE_ID`에 저장합니다.

Workers VPC용 Tunnel은 공개 ingress를 만들 필요가 없습니다. NAS 공유 포트,
SSH 또는 관리 UI를 VPC Service에 포함하지 않습니다. storage Worker token은
Account `Workers Scripts: Edit`만 부여하고, token 발급 사용자에게 기존 VPC
Service를 바인딩할 수 있는 `Connectivity Directory Bind` account member role을
부여합니다. Admin role은 필요하지 않습니다.

VPC Service는 fetch URL의 포트를 무시하고 등록된 포트를 사용하므로
`storage-production`의 `VPC_SERVICE_ID`와 `ORIGIN_BASE_URL`이 같은 Node origin을
가리키도록 설정한 뒤 storage Worker를 배포합니다.

공식 문서:

- [Tunnel for Workers VPC](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)
- [VPC Service binding](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)

## web Worker

web Worker는 `cache.enabled=false`로 배포합니다. 다음 바인딩만 가집니다.

```text
DB             D1 database
STORAGE_ADMIN  storage Worker의 비공개 Admin named entrypoint
```

GitHub Actions가 `web-production`의 변수로 임시 Wrangler JSON을 생성하며 job이
끝나면 runner와 함께 사라집니다. Worker secret은 Cloudflare 대시보드의 Worker
Settings에 직접 등록하고 배포에서는 `--keep-vars`를 사용해 유지합니다.

## 공개 storage Worker

storage Worker의 Custom Domain은 공개합니다. Worker 자체 caching을
활성화하고 `cross_version_cache=true`를 사용해 코드 배포가 origin 재요청 폭증으로
이어지지 않게 합니다.

기본 entrypoint와 `Admin`은 캐시하지 않고, 공개 이미지 처리를 하는 `Media`
named entrypoint만 캐시합니다. 정상 이미지 응답에는 해시 기반 캐시 태그와
장기 edge TTL을 설정합니다.

```http
Cache-Tag: blob-<sha256>
Cloudflare-CDN-Cache-Control: public, max-age=31536000, immutable
```

쿼리 문자열은 이미지 cache key에 포함하지 않습니다. 정상 `GET`/`HEAD`만
캐시하고 404, 인증 실패, origin 장애 응답은 저장하지 않습니다. Cache HIT이면
Worker 코드와 VPC/origin 요청이 실행되지 않아야 합니다.

공식 문서:

- [Workers Caching](https://developers.cloudflare.com/workers/cache/configuration/)
- [Purge by cache tag](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/)

## 도메인과 secret

Custom Domain과 DNS는 대시보드에서 설정합니다. 다음 값은
소스 코드나 Wrangler 파일에 넣지 않습니다.

- `CLOUDFLARE_API_TOKEN`
- account/zone ID, D1 ID, VPC Service ID
- Tunnel token
- origin 내부 인증 secret

런타임 secret이 필요하면 Cloudflare Worker 대시보드의 **Settings → Variables and
Secrets**에 encrypted secret으로 넣습니다. GitHub가 값을 갱신해야 하는 특별한
경우에만 해당 Worker 전용 Environment secret을 사용합니다.
