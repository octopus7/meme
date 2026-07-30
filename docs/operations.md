# 캐시, 삭제와 복구

## 런타임과 컨테이너

Node origin은 Synology Container Manager의 Debian Bookworm 기반 Node.js 24 LTS
컨테이너를 권장합니다. DSM 자체 Node 또는 native 라이브러리에 의존하지 않으며
`node:24-bookworm-slim` 기반 image를 보안 업데이트가 반영되도록 정기적으로
rebuild합니다.

- host에는 `127.0.0.1:8086`만 bind하고 라우터에 공개하지 않습니다.
- `.env`, `data/`, `logs/`는 container image와 분리해 백업합니다.
- read-only filesystem, capability drop, `no-new-privileges`가 유지되는지 확인합니다.
- Container Manager health와 restart 횟수를 감시합니다.

동일 계약의 .NET 10 origin은 8087에서 함께 실행할 수 있으며 storage Worker는
선택한 VPC Service binding과 `ORIGIN_BASE_URL`을 사용합니다.

## 캐시

이미지 URL은 파일 내용의 SHA-256으로 결정되므로 active 상태에서는 immutable
콘텐츠입니다.

```text
GET /i/<hash>.<ext>  원본
GET /t/<hash>        중앙 정사각형 crop 128×128 WebP
```

storage Worker caching은 배포 버전을 넘어 유지합니다. 캐시 key는 정규화한
method/host/path만 사용하며 query string으로 cache miss를 만들 수 없게 합니다.
첫 요청은 VPC와 origin을 통과하지만 HIT 요청은 내부 장비 트래픽을 만들지 않습니다.

운영 점검 시 같은 URL을 연속 요청하고 응답의 `Cf-Cache-Status`와 origin access
log를 함께 확인합니다. 단일 위치의 최초 요청은 MISS일 수 있으며, 아직 채워지지
않은 다른 edge location도 각각 최초 MISS가 발생할 수 있습니다.

## 참조 삭제

사용자가 삭제하면 해당 사용자의 논리 참조만 제거합니다. 다른 참조가 있으면
물리 파일과 공개 URL은 유지됩니다. 마지막 참조가 사라지면 다음 과정을 수행합니다.

```text
D1: trash_pending
→ origin: active에서 trash로 원자적 이동
→ Cache-Tag blob-<hash> 전역 purge
→ D1: trashed, purge_after = trashed_at + 30일
```

origin 이동과 cache purge의 짧은 비원자적 간격은 허용합니다. 작업은 idempotent하게
재시도하고, 두 단계가 끝나기 전에는 완료로 기록하지 않습니다. 404와 origin 오류는
캐시하지 않습니다.

사용자는 trash에 들어간 항목을 조회하거나 복구할 수 없습니다. 같은 hash를 다시
업로드해도 자동 복구하지 않고 충돌 상태를 반환해야 합니다. 30일 안의 복구 여부는
장비 관리자만 결정합니다.

## 관리자 복구

관리 절차는 감사 가능한 CLI 또는 직접 운영 명령으로 제한합니다.

1. D1에서 hash, 기존 참조와 `purge_after`를 확인합니다.
2. origin trash에 원본과 thumbnail이 모두 있고 hash가 일치하는지 확인합니다.
3. 관리자가 복구할 사용자 참조와 설명을 명시합니다.
4. origin 파일을 active로 옮기고 D1 상태와 참조를 transaction으로 복구합니다.
5. 새 요청으로 이미지가 제공되는지 확인합니다.

파일만 active로 옮기거나 D1 상태만 바꾸는 부분 복구는 금지합니다. 30일이 지나
`purged`가 된 파일은 서비스에서 복구할 수 없으며 별도 backup 정책의 대상입니다.

## 만료와 장애

origin 주기 작업은 디스크의 휴지통 record에서 만료 시각을 확인해 원본·thumbnail과
record를 삭제합니다. D1의 `trashed` 행은 사용자 검색에서 영구 제외되는 감사용
기록으로 남습니다. origin 삭제가 실패하면 record를 보존하고 다음 주기에
재시도합니다.

관찰할 항목:

- cache HIT 비율과 VPC/origin 요청 수
- cache purge 실패 및 오래 지속되는 `trash_pending`
- origin 디스크 여유와 trash 크기
- 30일이 지났지만 남은 `trashed` 항목
- hash/MIME/extension 불일치와 손상 격리 건수
