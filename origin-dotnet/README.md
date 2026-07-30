# meme origin (.NET 10)

Node.js origin과 같은 HTTP 계약을 구현한 독립 대체 서비스다. Node 서비스는
`127.0.0.1:8086`, 이 서비스는 충돌을 피하려고 `127.0.0.1:8087`을 사용한다.
8087용 Cloudflare VPC Service를 별도로 만들고 Worker의 `VPC_SERVICE_ID`와
`ORIGIN_BASE_URL`을 함께 바꾸면 같은 Worker 코드로 대체할 수 있다.

## 기능

- `GET|HEAD /i/{sha256}.{jpg|png|webp|gif}` 원본
- `GET|HEAD /t/{sha256}` 128×128 중앙 크롭 WebP
- Bearer 인증 `POST /internal/v1/blobs`
- Bearer 인증 `POST /internal/v1/blobs/{hash}/trash`
- 관리자용 `POST /internal/v1/blobs/{hash}/restore`
- 관리자용 `POST /internal/v1/admin/purge`
- SHA-256 중복 제거, Range/ETag/Last-Modified 조건부 응답
- 30일 휴지통과 자동 purge
- 일별 JSONL access log, 30일 후 gzip 압축 및 원본 `.log` 삭제

ImageSharp `3.1.12`를 exact pin한다. 이 구성은 개인·비상업 사용을 전제로
하며, 다른 용도로 배포하기 전에는 Six Labors Split License 조건을 직접
검토해야 한다. 배포물은 Linux x64 self-contained
single-file이므로 실행 서버에는 .NET 런타임이 필요 없지만, 현재 설치 스크립트의
로컬 publish 단계에는 .NET 10 SDK가 필요하다.

## 검사

```bash
dotnet restore origin-dotnet/Meme.Origin.slnx --locked-mode
dotnet test origin-dotnet/Meme.Origin.slnx --configuration Release --no-restore
```

처음 restore 때 생성한 `packages.lock.json`은 커밋하며, 이후 설치는 locked
restore로 재현한다.

## 설치 및 업데이트

로그인 사용자의 홈에 `~/meme`가 없으면 clone하고, 있으면 `git pull --ff-only`
후 publish/교체한다. `/etc/meme-origin-dotnet`과
`/var/lib/meme-origin-dotnet`은 릴리스와 분리되어 보존되며 healthcheck 실패 시
이전 `/opt/meme-origin-dotnet/releases/*`로 롤백한다.

```bash
bash origin-dotnet/deploy/install.sh --repo-url https://github.com/OWNER/meme.git
```

이미 clone되어 있다면:

```bash
bash ~/meme/origin-dotnet/deploy/install.sh
```

최초 설치 시 `/etc/meme-origin-dotnet/meme-origin-dotnet.env`에 임의 토큰을
생성한다. 실제 토큰을 Git에 넣지 않는다. Tunnel 또는 VPC origin은
`http://127.0.0.1:8087`에 연결하고 Worker secret의 Bearer 토큰을 동일하게
설정한다.
