# 캐시, 삭제와 복구

**한국어** | [English](operations.md)

## 런타임과 컨테이너

Node origin은 Synology Container Manager의 Debian Bookworm 기반 Node.js 24 LTS
컨테이너를 권장합니다. `node:24-bookworm-slim` 기반 image를 보안 업데이트가
반영되도록 정기적으로 rebuild합니다.

- host에는 `127.0.0.1:8086`만 bind하고 라우터에 공개하지 않습니다.
- `.env`, `data/`, `logs/`는 container image와 분리해 백업합니다.
- read-only filesystem, capability drop, `no-new-privileges`가 유지되는지 확인합니다.
- Container Manager health와 restart 횟수를 감시합니다.
- Cloudflare Tunnel connector 상태와 published hostname·Cache Rule 변경을 함께 감시합니다.

## 요청 경로와 CDN 캐시

이미지 URL은 파일 내용의 SHA-256으로 결정되므로 active 상태에서는 immutable
콘텐츠입니다.

```text
GET /i/<hash>.<ext>  원본
GET /t/<hash>        중앙 정사각형 crop 128×128 WebP
```

이미지 GET은 storage Worker를 거치지 않습니다.

```text
브라우저 → img.example.com → Cloudflare CDN
                              ├─ HIT: edge에서 응답
                              └─ MISS: Tunnel → Synology origin
```

Cloudflare Cache Rule에서 `/i/*`, `/t/*`를 명시적으로 cache eligible로 설정하고,
query string은 캐시 키에서 제거하거나 공개 경로에서 거부합니다. GET/HEAD 외
메서드와 404·5xx는 캐시하지 않습니다. `/t/{hash}`는 확장자가 없으므로 규칙에
별도로 포함해야 합니다.

정상 응답은 브라우저에 1년 immutable 캐시를 허용하고 동일한 blob tag를 보냅니다.

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Tag: blob-<sha256>
```

브라우저 로컬 캐시는 Cloudflare purge로 삭제할 수 없습니다. 로컬 캐시가 남아도
괜찮다는 정책이라면 그대로 두고, 신규 네트워크 요청의 접근 제어는 Cloudflare
edge cache와 origin 상태로 판단합니다. Cloudflare Cache Analytics와 Synology
origin access log에서 전체 CDN 동작을 확인할 수 있지만, 과거 storage Worker의
파일별 D1 HIT/MISS 로그는 더 이상 생성하지 않습니다.

## 이미지 URL 노출 기록

web Worker가 `/all` 또는 `/search` HTML에 이미지 URL을 포함하는 시점에만 D1의
`image_url_exposure_logs`에 best-effort로 기록합니다.

기록 필드:

```text
exposed_at, image_item_id, blob_hash, original_filename,
byte_size, exposure_context, viewer_sub
```

이는 브라우저가 실제로 이미지를 요청했는지, 로컬 캐시에서 읽었는지, Cloudflare
HIT인지, Tunnel까지 연결됐는지를 알려주지 않습니다. 로그 기록 실패가 목록·검색
응답을 실패시키지 않도록 합니다. 관리자는 `/exposures`에서 기간과 cursor를 사용해
조회하며, web Worker의 10분 cron이 90일이 지난 행을 bounded batch로 정리합니다.

## 참조 삭제와 edge purge

사용자가 삭제하면 해당 사용자의 논리 참조만 제거합니다. 다른 참조가 있으면 물리
파일과 공개 URL을 유지합니다. 마지막 참조가 사라지면 다음 순서를 지킵니다.

```text
D1: trash_pending
→ origin-admin: active에서 trash로 원자적 이동
→ Cloudflare Zone purge_cache(tags=[blob-<hash>])
→ D1: trashed, purge_after = trashed_at + 30일
```

web Worker는 `origin-admin.example.com`으로 HTTPS 요청을 보내고 origin Bearer
token으로 인증합니다.

```http
Authorization: Bearer <origin mutation token>
```

origin 이동과 edge purge 사이의 짧은 비원자적 간격은 허용합니다. purge 실패 시
`trash_pending`을 유지하고 web Worker cron이 재시도합니다. 두 단계가 끝나기 전에
`trashed`로 확정하지 않으며, 작업은 idempotent하게 구현합니다.

삭제 직후 동작은 다음과 같습니다.

```text
Cloudflare edge 캐시가 남아 있음 → purge 전까지 기존 이미지 응답 가능
tag purge 완료 → 새 요청은 edge MISS → origin에서 404
브라우저 로컬 캐시 → 이미 방문한 사용자의 화면에는 계속 남을 수 있음
```

404와 origin 오류는 장기 캐시하지 않습니다.

## 관리자 복구

관리 절차는 감사 가능한 관리자 UI 또는 직접 운영 명령으로 제한합니다.

1. D1에서 hash, 기존 참조와 `purge_after`를 확인합니다.
2. origin trash에 원본과 thumbnail이 모두 있고 hash가 일치하는지 확인합니다.
3. 관리자가 복구할 사용자 참조와 설명을 명시합니다.
4. origin 파일을 active로 옮기고 D1 상태와 참조를 transaction으로 복구합니다.
5. 필요하면 `blob-<hash>`를 다시 purge한 뒤 새 네트워크 요청으로 이미지가 제공되는지
   확인합니다.

파일만 active로 옮기거나 D1 상태만 바꾸는 부분 복구는 금지합니다. 30일이 지나
`purged`가 된 파일은 서비스에서 복구할 수 없으며 별도 backup 정책의 대상입니다.

## 만료와 장애

origin 주기 작업은 휴지통 record의 만료 시각을 확인해 원본·thumbnail과 record를
삭제합니다. D1의 `trashed` 행은 사용자 검색에서 영구 제외되는 감사용 기록으로
남깁니다. origin 삭제가 실패하면 record를 보존하고 다음 주기에 재시도합니다.

관찰할 항목:

- Cloudflare Cache Analytics의 전체 HIT/MISS와 Tunnel/origin 요청 수
- cache purge 실패 및 오래 지속되는 `trash_pending`
- origin Bearer token 인증 실패와 공개 이미지 hostname의 차단 요청
- origin 디스크 여유와 trash 크기
- 30일이 지났지만 남은 `trashed` 항목
- image URL 노출 기록 보존 작업과 D1 오류
- hash/MIME/extension 불일치와 손상 격리 건수
