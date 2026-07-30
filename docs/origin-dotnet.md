# .NET 10 origin 서비스

`origin-dotnet/`은 Node.js origin과 동일한 이미지 URI 및 JSON 계약을 구현하는
대체 서비스입니다.

- 기본 수신 주소: `http://127.0.0.1:8087`
- 배포 형태: .NET 10 `linux-x64` self-contained 실행 파일
- SDK 준비: 패키지 관리자 없이 `~/.dotnet`에 자동 설치
- 직접 설치 조건: x86_64, glibc 2.27 이상
- systemd unit: `meme-origin-dotnet.service`
- 상세 설치·업데이트·설정: [origin-dotnet README](../origin-dotnet/README.md)

Node origin(`127.0.0.1:8086`)과 데이터 디렉터리, 로그 디렉터리, systemd 계정 및
포트가 분리되어 있어 같은 장비에서 동시에 실행할 수 있습니다. storage Worker가
실제로 사용하는 origin은 GitHub `storage-production` Environment의
`VPC_SERVICE_ID`와 `ORIGIN_BASE_URL`을 함께 바꿔 선택합니다. VPC Service는
포트를 고정하므로 8086용과 8087용 Service를 각각 준비해야 합니다.

URI 호환은 데이터 자동 복제를 뜻하지 않습니다. Node와 .NET의 기본 데이터
디렉터리는 분리되어 있으므로 운영 전환 전에 active 원본·thumbnail·trash record를
중단 상태에서 검증해 마이그레이션해야 합니다.

`Build .NET origin` workflow는 artifact만 만들며 서버, Worker, D1 또는 다른
origin을 배포하거나 변경하지 않습니다.
