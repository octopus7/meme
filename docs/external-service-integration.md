# Worker+D1 서비스에서 meme 이미지 저장소 사용하기

이 문서는 새 서비스를 구현하는 에이전트에게 단독으로 전달하는 연동 명세입니다.
새 서비스는 Cloudflare Pages와 Worker를 분리하고, Worker에는 새 서비스 전용 D1을
연결합니다. `meme`는 이미지 파일 업로드와 공개 URL 서빙만 담당합니다.

## 확정된 역할

### 새 서비스

- Cloudflare Pages: 정적 HTML, CSS, JavaScript 제공
- Cloudflare Worker: 애플리케이션 API와 `meme` 업로드 호출
- 새 서비스 D1: 이미지 설명, 소유 관계, 게시물 관계, 검색용 데이터와 `meme`가
  반환한 이미지 주소 저장
- 사용자 로그인과 권한 처리: 필요한 경우 새 서비스가 자체적으로 처리

### meme

- 유효한 업로드 token을 가진 서버의 이미지 업로드 허용
- 업로드 결과로 원본과 미리보기의 공개 URL 반환
- 반환한 URL에서 이미지 `GET`/`HEAD` 제공
- Cloudflare CDN cache MISS일 때 Tunnel을 거쳐 origin에서 이미지 제공

### meme가 제공하지 않는 기능

- 사용자 로그인 또는 사용자 계정 연결
- 이미지 목록
- 이미지 검색
- 게시물이나 애플리케이션 메타데이터 관리
- 새 서비스 D1과의 직접 연결
- 이 연동 명세에서의 이미지 삭제 API

이미지를 올린 주체가 자신의 D1에 주소와 메타데이터를 저장하고 직접 목록과 검색을
구현합니다. `meme`에 목록 또는 검색 endpoint를 추가하지 않습니다.

## 전체 구조

```text
브라우저
├─ 정적 화면 ───────────────→ Cloudflare Pages
├─ 앱 API/업로드 ───────────→ 새 서비스 Worker ─→ 새 서비스 D1
│                                  │
│                                  └─ 업로드 token ─→ meme upload endpoint
└─ 공개 이미지 GET/HEAD ───→ meme 이미지 도메인 ─→ Cloudflare CDN
                                                        │ cache MISS
                                                        ▼
                                                  Tunnel → origin
```

Pages는 `meme`를 직접 호출하지 않습니다. 새 서비스 Worker가 업로드 token을 붙여
서버 간 요청을 보내고, 브라우저에는 업로드 결과로 받은 공개 이미지 URL만 전달합니다.

## 인증 원칙

이미지 업로드 자격은 사용자 로그인과 관계없이 `meme` 업로드 token으로만 판단합니다.

- 새 서비스 로그인 token, Google OAuth, session cookie를 `meme`에 보내지 않습니다.
- `meme` 업로드 token은 새 서비스 Worker 하나의 자격 증명입니다.
- 사용자가 새 서비스에 로그인했는지는 `meme`가 알 필요가 없습니다.
- 새 서비스에서 누가 업로드 기능을 사용할 수 있는지는 새 서비스 Worker가 자체적으로
  결정합니다.
- 이미지 조회에는 로그인과 token이 모두 필요하지 않습니다.

새 서비스 Worker는 `meme` 업로드 요청에 다음 헤더를 보냅니다.

```http
Authorization: Bearer <meme upload token>
```

token은 최소 32바이트의 암호학적으로 안전한 무작위 값을 사용합니다. 새 서비스
Worker의 encrypted secret에 `MEME_UPLOAD_TOKEN`으로 등록하고 Pages 환경 변수,
정적 JavaScript, D1, Git 저장소와 로그에는 넣지 않습니다.

기존 `meme`의 Google session secret, `ORIGIN_ADMIN_TOKEN`, cache purge token 또는
Tunnel token을 업로드 token으로 재사용하거나 새 서비스에 공유하면 안 됩니다.
`meme`에는 이 서비스만을 위한 **업로드 전용 token**을 별도로 만들어야 합니다.

## 선행 구현 사항

현재 `meme`의 브라우저 업로드 API는 Google session과 same-origin 요청을 전제로
합니다. origin의 기존 `/internal/v1/blobs`는 삭제·복구에도 사용되는 관리 token으로
보호됩니다. 둘 다 새 서비스가 직접 사용하면 안 됩니다.

따라서 `meme`에 다음 성격의 연동 endpoint를 먼저 추가합니다.

```text
POST https://<MEME_UPLOAD_HOST>/v1/images
```

이 endpoint는 다음 조건을 만족해야 합니다.

- `MEME_UPLOAD_TOKEN`에 대응하는 별도 token만 허용
- 업로드 이외의 origin 관리 작업 권한은 부여하지 않음
- request body를 origin 저장 로직으로 스트리밍
- 성공 시 완성된 공개 이미지 URL을 JSON으로 반환
- 목록, 검색, 사용자 조회와 삭제 endpoint는 만들지 않음

이 경로는 목표 계약입니다. 실제 배포에서 endpoint와 전용 token 검증이 구현되어
호출 시험을 통과하기 전까지 연동 완료로 판단하지 않습니다.

## 업로드 API 계약

요청 body는 multipart가 아닌 원본 이미지 bytes입니다.

```http
POST /v1/images HTTP/1.1
Authorization: Bearer <meme upload token>
Content-Type: image/png
Content-Length: 12345
Idempotency-Key: <unique value>
X-Original-Filename: example.png

<raw image bytes>
```

`X-Original-Filename`에 ASCII 이외의 문자가 있으면 `encodeURIComponent`한 값을
전송하고 `meme`에서 한 번만 decode합니다. 이미지 설명, 태그와 게시물 정보는
`meme`에 보내지 않고 새 서비스 D1에 저장합니다.

`meme` upload endpoint는 다음을 검증합니다.

- `Authorization: Bearer` token
- `Content-Length` 존재 여부와 최대 업로드 byte 수
- JPEG, PNG, WebP, GIF 실제 파일 형식
- 최대 pixel 수
- 원래 파일명 길이
- token 단위 rate limit과 업로드 동시성
- 같은 token과 `Idempotency-Key` 조합의 중복 요청

권장 성공 응답:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Cache-Control: private, no-store
```

```json
{
  "hash": "<sha256>",
  "extension": "png",
  "mime_type": "image/png",
  "byte_size": 12345,
  "original_url": "https://img.example.com/i/<sha256>.png",
  "thumbnail_url": "https://img.example.com/t/<sha256>"
}
```

새 서비스는 `original_url`과 `thumbnail_url`을 직접 조립하지 않고 응답값을 그대로
저장합니다.

권장 오류 응답:

| 상태 | 의미 | 새 서비스 처리 |
|---|---|---|
| `400` | 이미지 형식 또는 요청 메타데이터 오류 | 사용자에게 오류 표시, 재시도 안 함 |
| `401` | token 없음 또는 불일치 | 운영 오류로 기록, token 확인 |
| `413` | 허용 크기 초과 | 사용자에게 크기 제한 표시 |
| `429` | rate limit 초과 | `Retry-After`를 존중해 제한 재시도 |
| `5xx` | 일시적인 저장소·Tunnel 장애 | 지수 backoff로 제한 재시도 |

오류 JSON은 세부 내부 경로, token 또는 origin 관리 정보를 포함하지 않습니다.

## 새 서비스 Worker 구현

Pages에서 받은 이미지 body를 전체 buffering하지 말고 가능한 한 `meme`로
스트리밍합니다.

새 서비스 Worker 환경 설정:

```text
MEME_UPLOAD_BASE_URL=https://<MEME_UPLOAD_HOST>   일반 설정
MEME_IMAGE_ORIGIN=https://<MEME_IMAGE_HOST>      일반 설정
MEME_UPLOAD_TOKEN=<secret>                       encrypted secret
```

처리 순서:

```text
Pages의 업로드 요청
→ 새 서비스 Worker의 자체 요청 검증
→ 고유 Idempotency-Key 생성
→ meme upload endpoint로 body 스트리밍
→ meme 응답의 URL과 hash 검증
→ 새 서비스 D1에 애플리케이션 데이터와 URL 저장
→ Pages에 필요한 결과만 반환
```

새 서비스 Worker는 `meme` 응답을 신뢰하기 전에 다음을 확인합니다.

- `hash`가 64자리 소문자 hexadecimal인지
- `extension`이 허용 목록에 있는지
- 두 URL이 HTTPS이며 운영자가 설정한 정확한 이미지 hostname인지
- 원본 경로가 `/i/<hash>.<extension>`인지
- 미리보기 경로가 `/t/<hash>`인지
- URL에 query와 fragment가 없는지

## 새 서비스 D1 저장

이미지 파일 bytes는 D1에 저장하지 않습니다. 애플리케이션 테이블에는 필요한
관계 데이터와 함께 최소한 다음 값을 저장합니다.

```text
meme_hash
meme_original_url
meme_thumbnail_url
meme_mime_type
meme_byte_size
created_at
```

파일명, 설명, 태그, 업로더와 게시물 관계는 전부 새 서비스의 데이터입니다. 목록과
검색도 이 D1만 사용해 구현합니다. `meme` D1을 바인딩하거나 조회하지 않습니다.

업로드는 `meme` 파일 저장과 새 서비스 D1 쓰기로 나뉘므로 하나의 transaction이
아닙니다.

1. `meme` 업로드가 실패하면 새 서비스 D1 레코드를 확정하지 않습니다.
2. `meme` 업로드가 성공했지만 D1 쓰기가 실패하면 같은 `Idempotency-Key`로 재시도해
   같은 업로드 결과를 받습니다.
3. 요청 id와 hash는 구조화된 로그에 남길 수 있지만 token과 이미지 body는 남기지
   않습니다.

## 공개 이미지 서빙

공개 이미지 URL 형식:

| 종류 | URL |
|---|---|
| 원본 | `https://<MEME_IMAGE_HOST>/i/<sha256>.<ext>` |
| 128×128 WebP 미리보기 | `https://<MEME_IMAGE_HOST>/t/<sha256>` |

조회는 `GET`과 `HEAD`만 허용하고 인증은 요구하지 않습니다. URL을 획득한 사람은
누구나 이미지를 볼 수 있습니다. URL을 비밀 링크나 접근 제어 수단으로 간주하면
안 되며 민감한 이미지를 저장하지 않습니다.

브라우저는 새 서비스 Worker를 거치지 않고 반환받은 이미지 URL을 직접 `<img>`에
사용합니다. Cloudflare CDN cache HIT이면 Tunnel과 origin까지 요청이 전달되지
않습니다.

성공 이미지 응답은 장기간 immutable하게 캐시될 수 있습니다.

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Tag: blob-<sha256>
Cross-Origin-Resource-Policy: cross-origin
```

일반적인 `<img src="...">` 표시는 CORS 없이 가능합니다. 브라우저 JavaScript가
이미지 body나 canvas 픽셀을 읽는 기능은 이 명세의 범위가 아니며 별도 CORS를
요구할 수 있습니다.

## Pages와 Worker 분리

Pages와 새 서비스 Worker가 서로 다른 origin이면 새 서비스 Worker가 정확한 Pages
origin에 대해서만 CORS를 허용합니다. `meme` upload endpoint를 브라우저용 CORS로
열지 않습니다.

- Pages는 새 서비스 Worker만 호출합니다.
- 새 서비스 Worker만 `MEME_UPLOAD_TOKEN`을 보유합니다.
- 허용하는 Pages origin, method와 request header를 최소화합니다.
- 필요한 `OPTIONS` preflight를 새 서비스 Worker에서 처리합니다.
- `MEME_UPLOAD_TOKEN`을 Pages 번들, 응답, 오류 body 또는 브라우저 요청에 넣지
  않습니다.

## 보관 정책

이 연동은 업로드와 공개 서빙만 제공합니다. 삭제 API가 없으므로 업로드된 파일은
운영자의 별도 보관 정책이 적용될 때까지 남습니다. 나중에 삭제가 필요해지면 업로드
token과 분리된 권한 및 별도 계약으로 설계하며, 현재 문서에 임의로 삭제 호출을
추가하지 않습니다.

## 금지 사항

- Google session cookie로 기존 브라우저 API를 자동화하지 않습니다.
- 기존 `ORIGIN_ADMIN_TOKEN`을 새 서비스에 공유하지 않습니다.
- origin의 `/internal/*` 관리 API를 직접 호출하지 않습니다.
- `/all`이나 `/api/search`를 scraping하지 않습니다.
- 새 서비스 Worker에서 `meme` D1을 직접 읽지 않습니다.
- Pages나 브라우저에 업로드 token을 전달하지 않습니다.
- 공개 이미지 URL을 인증 또는 권한 확인 수단으로 사용하지 않습니다.

## 구현 체크리스트

### meme

- [ ] 새 서비스 전용 업로드 token 발급
- [ ] 업로드 전용 `POST /v1/images` 구현
- [ ] 기존 관리 token과 업로드 token의 권한 분리
- [ ] raw body 스트리밍, 형식·크기·pixel 검증 구현
- [ ] idempotency와 token 단위 rate limit 구현
- [ ] 완성된 원본/미리보기 공개 URL 반환
- [ ] 공개 이미지 hostname은 `GET`/`HEAD`만 허용
- [ ] token 없음·오류, 과대 파일, 중복 요청과 origin 장애 테스트

### 새 서비스 Worker+D1

- [ ] 새 서비스 전용 D1을 Worker에 바인딩
- [ ] `MEME_UPLOAD_TOKEN`을 Worker encrypted secret으로 등록
- [ ] Pages 업로드를 받아 `meme`로 스트리밍
- [ ] 응답의 hash, 확장자와 hostname 검증
- [ ] 반환된 URL과 애플리케이션 메타데이터를 새 서비스 D1에 저장
- [ ] 검색과 목록은 새 서비스 D1만 사용
- [ ] 정확한 Pages origin만 허용하는 CORS 구현
- [ ] 재시도에도 같은 `Idempotency-Key` 사용
- [ ] token과 이미지 body가 로그에 남지 않는지 확인

### Pages

- [ ] 정적 자산만 배포하고 업로드 token을 포함하지 않음
- [ ] 업로드는 새 서비스 Worker만 호출
- [ ] 이미지 표시는 반환된 공개 URL을 직접 사용

## 완료 조건

1. 유효한 전용 token으로 이미지 업로드가 성공하고 공개 URL 두 개가 반환됩니다.
2. token이 없거나 틀린 업로드는 `401`입니다.
3. 같은 파일의 공개 URL은 로그인과 token 없이 `GET`/`HEAD`로 열립니다.
4. Pages 번들과 브라우저 network 요청에 업로드 token이 없습니다.
5. 새 서비스 로그인 유무가 `meme`의 업로드 인증과 이미지 조회에 영향을 주지
   않습니다.
6. 새 서비스 D1에 URL과 애플리케이션 메타데이터가 저장되고 목록·검색은 그 D1에서만
   수행됩니다.
7. 새 서비스는 기존 `meme` D1, Google session과 origin 관리 API를 사용하지 않습니다.
