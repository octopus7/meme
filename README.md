# meme

Google 로그인을 통과한 사용자만 이미지를 등록하고 검색하는 개인용 이미지 보관 서비스입니다.
관리 화면은 Cloudflare Worker와 D1에서 동작하고, 원본 파일과 128×128 WebP
미리보기는 집 안의 Linux 서버에 저장됩니다. 공개 이미지 Worker는 Workers VPC와
Cloudflare Tunnel을 통해서만 원본 서버에 접근하며, 성공 응답을 엣지에 캐시합니다.

## 구성

```text
브라우저
├─ app.example.com  ─ Access(Google) ─ web Worker ─ D1
└─ img.example.com  ─ 공개 ─ image Worker ─ Workers VPC ─ Tunnel ─ 선택한 origin
                              └─ Cloudflare edge cache
```

- `/`는 로그인 진입점이며 로그인 후 `/search`로 이동합니다.
- `/search`는 빈 검색 입력 화면으로 시작합니다. 입력 중 최대 5개의 결과만 갱신합니다.
- `/all`은 로그인 사용자의 전체 목록을 페이지 단위로 표시합니다.
- `/i/{sha256}.{ext}`는 원본, `/t/{sha256}`는 128×128 WebP 미리보기입니다.
- 물리 파일은 내용 해시로 중복 제거되며, 사용자의 설명과 원래 파일명은 D1에서
  별도의 참조로 관리됩니다.
- 마지막 참조가 삭제되면 즉시 공개 경로가 무효화되고 캐시 태그를 퍼지합니다.
  파일은 관리자만 복구할 수 있는 휴지통에 30일간 보관한 뒤 삭제합니다.

## 설치와 운영 문서

1. [아키텍처와 요청 흐름](docs/architecture.md)
2. [전체 설치 순서](docs/installation.md)
3. [Cloudflare Access와 Google 로그인](docs/cloudflare-access.md)
4. [D1, Workers VPC, Tunnel과 Worker 설정](docs/cloudflare.md)
5. [Node.js origin 서비스 설치](docs/origin.md)
6. [.NET 10 origin 서비스](docs/origin-dotnet.md)
7. [GitHub Actions 변수·비밀 및 격리 정책](docs/github-actions.md)
8. [캐시, 삭제와 복구 동작](docs/operations.md)
9. [운영 설정 체크리스트](docs/setup-checklist.md)

실제 계정 ID, 데이터베이스 ID, VPC Service ID, 도메인, 토큰 및 Tunnel 토큰은
저장소에 커밋하지 않습니다. 예시의 `<...>` 값은 Cloudflare 대시보드나 GitHub
Environment에서 설정해야 합니다.

## 저장소 격리

| 디렉터리 | 배포 대상 |
|---|---|
| `workers/web` | 인증 웹 UI와 D1 API Worker |
| `workers/storage` | 공개 이미지·VPC gateway Worker |
| `origin` | Node.js 이미지 저장 서비스, 기본 포트 8086 |
| `origin-dotnet` | 동일 계약의 .NET 10 이미지 저장 서비스, 기본 포트 8087 |
| `database/d1/migrations` | D1 스키마 |
| `.github/workflows` | 대상별 독립 CI/CD |

각 Worker는 별도 lockfile과 GitHub Environment를 사용합니다. Worker 배포는 다른
Worker, D1 migration 또는 Linux 서버의 파일을 변경하지 않습니다.

두 origin은 동시에 실행할 수 있지만 storage Worker는 한 번에 하나의 VPC Service만
바인딩합니다. 구현 전환에는 Worker 코드 변경이 필요하지 않지만
`VPC_SERVICE_ID`와 `ORIGIN_BASE_URL`을 함께 바꾸고, 새 origin에 기존 active·trash
데이터가 동일하게 준비되어 있어야 합니다.
