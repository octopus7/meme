# meme

이미지를 등록하고 검색하는 개인용 이미지 보관 서비스입니다. 웹 화면과 API는
Google OpenID Connect 로그인을 요구합니다. 환경 변수에는 관리자 이메일 하나만
두며, 관리자는 일반 Google 회원의 접근 허용 여부를 화면에서 켜고 끕니다.
관리 화면은 Cloudflare Worker와 D1에서 동작하고, 원본 파일과 128×128 WebP
미리보기는 집 안의 Linux 서버에 저장됩니다. 공개 이미지 도메인은 Cloudflare
Tunnel을 통해 원본 서버에 직접 연결되고, 성공 응답은 Cloudflare 엣지에 캐시됩니다.

이전 Reddit 글을 보고 방문했다면, 당시의 Workers VPC 구성은 [`v1-vpc-final` 태그와
릴리스](https://github.com/octopus7/meme/releases/tag/v1-vpc-final)로 보존되어
있습니다. 새로 설치하거나 이전할 때는 아래의 현재 직접 Tunnel 구성을 사용하세요.

## 구성

```text
브라우저
├─ app.example.com  ─ Google 인증 ─ web Worker ─ D1
├─ img.example.com  ─ 공개 ─ Cloudflare edge cache ─ Tunnel ─ Node origin
└─ origin-admin.example.com  ─ Bearer token ─ Tunnel ─ Node origin
```

- 인증된 사용자의 `/`는 `/all`로 이동합니다. 비로그인 상태에서는 로그인 버튼을 표시합니다.
- `/search`는 빈 검색 입력 화면으로 시작하며 로그인한 사용자가 올린 항목만 검색합니다.
- `/all`은 로그인한 사용자가 올린 항목만 페이지 단위로 표시합니다.
- 이미지 원본 URL을 직접 아는 경우에는 기존처럼 파일을 열 수 있지만, 다른 사용자의 항목은 목록과 검색으로 찾을 수 없습니다.
- 관리자는 `/all`의 톱니바퀴에서 회원 접근 설정과 90일 이미지 URL 노출 기록을 봅니다.
- 노출 기록은 web Worker가 `/all`·`/search` 응답에 URL을 넣은 시각·파일명·용량·화면·viewer sub를
  남기는 best-effort 감사 로그입니다. 실제 다운로드, 브라우저 캐시, Cloudflare HIT 여부는 알 수 없습니다.
- `/i/{sha256}.{ext}`는 원본, `/t/{sha256}`는 128×128 WebP 미리보기입니다.
- 물리 파일은 내용 해시로 중복 제거되며, 설명과 원래 파일명은 D1에서
  별도의 참조로 관리됩니다.
- 마지막 참조가 삭제되면 즉시 공개 경로가 무효화되고 캐시 태그를 퍼지합니다.
  파일은 관리자만 복구할 수 있는 휴지통에 30일간 보관한 뒤 삭제합니다.

## 설치와 운영 문서

1. [아키텍처와 요청 흐름](docs/architecture.md)
2. [전체 설치 순서](docs/installation.md)
3. [D1, Tunnel, CDN과 Worker 설정](docs/cloudflare.md)
4. [Node.js origin 서비스 설치](docs/origin.md)
5. [GitHub Actions 변수·비밀 및 격리 정책](docs/github-actions.md)
6. [Google OAuth 설정](docs/google-oauth.md)
7. [캐시, 삭제와 복구 동작](docs/operations.md)
8. [운영 설정 체크리스트](docs/setup-checklist.md)

실제 계정 ID, 데이터베이스 ID, 도메인, 토큰 및 Tunnel 토큰은
저장소에 커밋하지 않습니다. 예시의 `<...>` 값은 Cloudflare 대시보드나 GitHub
Environment에서 설정해야 합니다.

## 저장소 격리

| 디렉터리 | 배포 대상 |
|---|---|
| `workers/web` | Google 인증 웹 UI와 D1 API Worker |
| `origin` | Node.js 이미지 저장 서비스, 기본 포트 8086 |
| `database/d1/migrations` | D1 스키마 |
| `.github/workflows` | 대상별 독립 CI/CD |

각 Worker는 별도 lockfile과 GitHub Environment를 사용합니다. Worker 배포는 다른
Worker, D1 migration 또는 Linux 서버의 파일을 변경하지 않습니다.
