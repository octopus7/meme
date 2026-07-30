# Linux origin 서비스 설치

origin은 x86-64 Linux에서 Node.js 20 호환 런타임과 `sharp`로 이미지를 처리하며 `systemd`
서비스로 실행합니다. Worker 배포와 Linux 설치는 완전히 분리되어 있습니다.

> **호환 모드 경고:** Node.js 20은 2026년 3월 24일 EOL에 도달해 보안 업데이트가
> 종료되었습니다. 이 프로젝트에서는 XPEnology/Synology 장비 제약 때문에
> Node.js 20.9.0 이상과 보안 수정된 `sharp` 0.35.3을 고정해 사용합니다. origin을 인터넷에
> 직접 공개하지 말고, 장비가 허용하는 즉시 Node.js 22 이상의 지원 중인 LTS로
> 올릴 계획을 마련해야 합니다.

## 준비 사항

- x86-64(`linux-x64`) systemd Linux
- Node.js 20.9.0 이상과 Node에 포함된 npm
- glibc 2.28 이상과 lockfile에 정확히 고정된 `sharp` 0.35.3
- `sudo`, `curl`, OpenSSL 및 일반 계정 관리 도구
- `/var/lib/meme-origin`과 `/var/log/meme-origin`을 위한 디스크와 별도 백업

다음 명령에서 Node 버전이 20.9.0 이상인지 확인합니다.

```bash
node --version
npm --version
```

`sharp`는 플랫폼별 네이티브 모듈을 사용합니다. Windows나 macOS에서 생성한
`node_modules`를 서버로 복사하지 않습니다. GitHub Actions의 Linux x64 runner가
만든 artifact를 사용하거나 Linux 장비에서 `npm ci --omit=dev`를 실행합니다.

## 권장: 하나의 설치·업데이트 스크립트

로그인 사용자로 스크립트를 실행합니다. 최초 실행은 저장소를 `~/meme`에 clone하고,
이후 실행은 `git pull --ff-only`로 변경을 받은 뒤 새 immutable release를 설치합니다.

```bash
curl --fail --location --output /tmp/meme-origin-install.sh \
  https://raw.githubusercontent.com/<OWNER>/<REPOSITORY>/main/origin/deploy/install.sh
bash /tmp/meme-origin-install.sh \
  --repo-url https://github.com/<OWNER>/<REPOSITORY>.git
```

업데이트는 같은 스크립트 하나로 처리합니다.

```bash
bash ~/meme/origin/deploy/install.sh
```

스크립트는 Node·x86-64·glibc를 사전 검사하고, 실제 `sharp` 로드와 8086 health check가
성공한 뒤에만 release를 전환합니다. 기존 env, 데이터와 로그는 덮어쓰지 않으며
실패하면 직전 release symlink로 되돌립니다. Synology의 Node 실행 파일이
`/usr/bin/node` 밖에 있어도 현재 실행 파일을 `/opt/meme-origin/node`에 연결해
systemd가 같은 바이너리를 사용하게 합니다.

## 선택: GitHub artifact 준비

GitHub Actions의 `Build origin` 결과에서 현재 commit의
`meme-origin-node20-linux-x64-<commit>` artifact를 내려받고 checksum과 commit을
확인합니다. artifact에는 Node.js 애플리케이션, lockfile, Linux x64용 production
의존성 및 `deploy/`의 systemd 파일만 들어 있습니다. 실제 환경 파일과 mutation
token은 포함되지 않습니다.

Worker workflow에는 Linux 서버 접속 키가 없으며 이 artifact를 서버로 전송하거나
서비스를 재시작하지 않습니다. 서버 반영은 장비 관리자가 별도로 수행합니다.

## 최초 설치

전용 계정과 영속 디렉터리를 만듭니다.

```bash
sudo useradd --system --home /var/lib/meme-origin --shell /usr/sbin/nologin meme-origin
sudo install -d -o meme-origin -g meme-origin -m 0750 /var/lib/meme-origin
sudo install -d -o meme-origin -g meme-origin -m 0750 /var/log/meme-origin
sudo install -d -o root -g root -m 0755 /etc/meme-origin
sudo install -d -o root -g root -m 0755 /opt/meme-origin/releases
```

artifact를 임시 디렉터리에 풀고 애플리케이션을 설치합니다. 아래 `app/`과
`deploy/`는 artifact 내부 경로이며 `<RELEASE_ID>`는 배포 commit을 식별할 수 있는
값으로 정합니다.

```bash
sudo install -d -o root -g root -m 0755 /opt/meme-origin/releases/<RELEASE_ID>
sudo cp -a ./app/. /opt/meme-origin/releases/<RELEASE_ID>/
sudo chown -R root:root /opt/meme-origin/releases/<RELEASE_ID>
sudo ln -sfn "$(realpath "$(command -v node)")" /opt/meme-origin/node
sudo ln -sfn /opt/meme-origin/releases/<RELEASE_ID> /opt/meme-origin/current
sudo install -o root -g root -m 0644 ./deploy/meme-origin.service \
  /etc/systemd/system/meme-origin.service
sudo install -o root -g meme-origin -m 0600 ./deploy/meme-origin.env.example \
  /etc/meme-origin/meme-origin.env
```

`/etc/meme-origin/meme-origin.env`를 편집해 예제 token을 교체합니다. 다음 명령은
값을 화면에 출력하므로 개인 터미널에서만 실행하고 shell history에 token을
직접 입력하지 않습니다.

```bash
openssl rand -hex 32
sudoedit /etc/meme-origin/meme-origin.env
```

기본 설정의 의미는 다음과 같습니다.

```dotenv
MEME_ORIGIN_HOST=127.0.0.1
MEME_ORIGIN_PORT=8086
MEME_ORIGIN_DATA_DIR=/var/lib/meme-origin
MEME_ORIGIN_ACCESS_LOG_DIR=/var/log/meme-origin
MEME_ORIGIN_MUTATION_TOKEN=<AT_LEAST_32_RANDOM_CHARACTERS>
MEME_ORIGIN_MAX_UPLOAD_BYTES=26214400
MEME_ORIGIN_MAX_IMAGE_PIXELS=80000000
MEME_ORIGIN_TRASH_RETENTION=720h
MEME_ORIGIN_PURGE_INTERVAL=1h
```

같은 mutation token을 storage Worker의 Cloudflare encrypted secret
`ORIGIN_ADMIN_TOKEN`에 등록합니다. 실제 env 파일, token 또는 server 주소를
저장소나 artifact에 넣지 않습니다.

`cloudflared`가 같은 장비에서 실행되면 loopback 주소를 유지합니다. 다른 사설
장비에서 실행되면 `MEME_ORIGIN_HOST`를 특정 사설 인터페이스로 바꾸고 host
firewall에서 Tunnel 장비만 허용합니다. 라우터 port forwarding은 만들지 않습니다.

## 시작과 확인

unit의 `ExecStart`가
`/opt/meme-origin/node /opt/meme-origin/current/src/index.js`이고 `WorkingDirectory`가
`/opt/meme-origin/current`인지 확인한 다음 서비스를 시작합니다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meme-origin.service
systemctl status meme-origin.service
journalctl -u meme-origin.service --since today
curl --fail http://127.0.0.1:8086/healthz
```

서비스 계정에서 native `sharp`를 불러오지 못하면 artifact가 Linux x64에서
생성됐는지, Node.js가 20.9.0 이상인지, 설치 버전이 `sharp` 0.35.3인지 먼저
확인합니다.

## 업데이트

새 artifact를 별도 임시 디렉터리에 풀어 commit과 구성을 확인한 뒤 immutable
release 디렉터리를 추가하고 `current` symlink와 unit만 교체합니다.
`/etc/meme-origin/meme-origin.env`,
`/var/lib/meme-origin`, `/var/log/meme-origin`은 덮어쓰지 않습니다.

```bash
sudo install -d -o root -g root -m 0755 /opt/meme-origin/releases/<NEW_RELEASE_ID>
sudo cp -a ./app/. /opt/meme-origin/releases/<NEW_RELEASE_ID>/
sudo chown -R root:root /opt/meme-origin/releases/<NEW_RELEASE_ID>
sudo ln -sfn /opt/meme-origin/releases/<NEW_RELEASE_ID> /opt/meme-origin/current
sudo systemctl restart meme-origin.service
curl --fail http://127.0.0.1:8086/healthz
```

health check가 실패하면 `current`를 직전 release로 다시 연결하고 서비스를
재시작합니다. 데이터와 환경 파일은 rollback하거나 삭제하지 않습니다. 정상
동작을 확인한 뒤에도 적어도 직전 release 하나는 남겨 둡니다.

## 운영

- access log에 query, Authorization, token 또는 request body가 기록되지 않는지 확인합니다.
- UTC 일별 `access-YYYY-MM-DD.log`가 생성되는지 확인합니다.
- 30일이 지난 `.log`가 `.log.gz`로 압축된 뒤 원본만 삭제되는지 확인합니다.
- `/var/lib/meme-origin/tmp`의 중단된 업로드를 정리합니다.
- 원본과 휴지통을 포함해 별도 백업을 운영합니다.
- 디스크 여유, systemd restart 횟수, Tunnel 상태와 5xx를 감시합니다.
- 30일 purge 작업이 재시작 후 영속 상태를 기준으로 재개되는지 점검합니다.
- `npm install`을 서비스 시작 때마다 실행하지 않습니다.
- origin REST port를 인터넷에 공개하지 않습니다.
- EOL 런타임 사용을 위험 등록부에 기록하고 Node.js 22 이상 전환 가능성을 정기적으로 확인합니다.
