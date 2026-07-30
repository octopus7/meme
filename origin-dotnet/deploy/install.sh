#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repo_url="${MEME_REPO_URL:-}"
no_pull=0
while (($#)); do
  case "$1" in
    --repo-url) repo_url="${2:?--repo-url requires a value}"; shift 2 ;;
    --no-pull) no_pull=1; shift ;;
    -h|--help) echo "Usage: install.sh [--repo-url URL] [--no-pull]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "${EUID}" -ne 0 ]] || { echo "Run as the login user, not with sudo." >&2; exit 1; }
for command in git sudo systemctl curl openssl realpath getent groupadd useradd \
  install mktemp sed uname date readlink sleep cp chmod mv rm unlink awk getconf tar gzip; do
  command -v "${command}" >/dev/null || { echo "Missing command: ${command}" >&2; exit 1; }
done

home_real="$(realpath -e "${HOME}")"
clone="${home_real}/meme"
[[ ! -L "${clone}" ]] || { echo "Clone path must not be a symlink." >&2; exit 1; }
prepare_repo() {
  if [[ ! -e "${clone}" ]]; then
    [[ -n "${repo_url}" ]] || { echo "--repo-url or MEME_REPO_URL is required." >&2; exit 1; }
    git clone -- "${repo_url}" "${clone}"
  elif [[ ! -d "${clone}/.git" ]]; then
    echo "${clone} is not a Git repository." >&2; exit 1
  elif [[ "${no_pull}" -eq 0 ]]; then
    git -C "${clone}" pull --ff-only
  fi
  [[ "$(realpath -e "${clone}")" == "${home_real}/meme" ]] || exit 1
  [[ "$(realpath -e "$(git -C "${clone}" rev-parse --show-toplevel)")" == "${clone}" ]] || exit 1
  [[ -f "${clone}/origin-dotnet/Meme.Origin.slnx" && -f "${clone}/origin-dotnet/deploy/install.sh" ]] || exit 1
}

if [[ "${MEME_DOTNET_INSTALL_REEXEC:-0}" != "1" ]]; then
  prepare_repo
  exec env MEME_DOTNET_INSTALL_REEXEC=1 MEME_REPO_URL="${repo_url}" \
    bash "${clone}/origin-dotnet/deploy/install.sh" --no-pull
fi
prepare_repo
origin="$(realpath -e "${clone}/origin-dotnet")"
[[ "${origin}" == "${clone}/origin-dotnet" ]] || exit 1
[[ "$(uname -m)" == "x86_64" ]] || { echo "Only Linux x86_64 is supported." >&2; exit 1; }
glibc_version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
[[ "${glibc_version}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  echo "Cannot determine the glibc version required by .NET 10." >&2
  exit 1
}
awk -v version="${glibc_version}" 'BEGIN {
  split(version, parts, ".")
  exit !((parts[1] + 0) > 2 || ((parts[1] + 0) == 2 && (parts[2] + 0) >= 27))
}' || {
  echo ".NET 10 requires glibc 2.27 or newer; found ${glibc_version}." >&2
  echo "Use a container with a newer Linux user space on this device." >&2
  exit 1
}

dotnet_bin="$(command -v dotnet || true)"
if [[ -z "${dotnet_bin}" ]] || [[ "$("${dotnet_bin}" --version 2>/dev/null || true)" != 10.* ]]; then
  dotnet_dir="${HOME}/.dotnet"
  dotnet_installer="$(mktemp /tmp/dotnet-install.XXXXXXXX.sh)"
  trap 'rm -f -- "${dotnet_installer:-}"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${dotnet_installer}" \
    https://dot.net/v1/dotnet-install.sh
  chmod 0700 "${dotnet_installer}"
  bash "${dotnet_installer}" \
    --channel 10.0 \
    --quality GA \
    --architecture x64 \
    --install-dir "${dotnet_dir}" \
    --no-path
  rm -f -- "${dotnet_installer}"
  trap - EXIT
  dotnet_bin="${dotnet_dir}/dotnet"
fi
[[ -x "${dotnet_bin}" ]] && [[ "$("${dotnet_bin}" --version)" == 10.* ]] || {
  echo "Failed to install or locate the .NET 10 SDK." >&2
  exit 1
}
export DOTNET_ROOT
DOTNET_ROOT="$(dirname "$(realpath -e "${dotnet_bin}")")"
export PATH="${DOTNET_ROOT}:${PATH}"
echo ".NET SDK: $("${dotnet_bin}" --version) (${DOTNET_ROOT})"

sudo -v
if ! getent group meme-origin-dotnet >/dev/null; then sudo groupadd --system meme-origin-dotnet; fi
if ! getent passwd meme-origin-dotnet >/dev/null; then
  sudo useradd --system --gid meme-origin-dotnet --home-dir /var/lib/meme-origin-dotnet \
    --shell /usr/sbin/nologin meme-origin-dotnet
fi
sudo install -d -o meme-origin-dotnet -g meme-origin-dotnet -m 0750 \
  /var/lib/meme-origin-dotnet /var/log/meme-origin-dotnet
sudo install -d -o root -g root -m 0755 /opt/meme-origin-dotnet /opt/meme-origin-dotnet/releases
sudo install -d -o root -g meme-origin-dotnet -m 0750 /etc/meme-origin-dotnet

env_file=/etc/meme-origin-dotnet/meme-origin-dotnet.env
if ! sudo test -f "${env_file}"; then
  token="$(openssl rand -hex 32)"
  temp_env="$(mktemp /tmp/meme-origin-dotnet-env.XXXXXXXX)"
  trap 'rm -f -- "${temp_env:-}"' EXIT
  sed "s/replace-with-at-least-32-random-characters/${token}/" \
    "${origin}/deploy/meme-origin-dotnet.env.example" >"${temp_env}"
  chmod 0600 "${temp_env}"
  sudo install -o root -g root -m 0600 "${temp_env}" "${env_file}"
  unset token
fi

release_id="$(date -u +%Y%m%d%H%M%S)-$(git -C "${clone}" rev-parse --short=12 HEAD)"
release="/opt/meme-origin-dotnet/releases/${release_id}"
publish="$(mktemp -d /tmp/meme-origin-dotnet-publish.XXXXXXXX)"
trap 'rm -rf -- "${publish:-}" "${temp_env:-}"' EXIT
"${dotnet_bin}" restore "${origin}/src/Meme.Origin/Meme.Origin.csproj" \
  --runtime linux-x64 --locked-mode
"${dotnet_bin}" publish "${origin}/src/Meme.Origin/Meme.Origin.csproj" \
  --configuration Release --runtime linux-x64 --self-contained true \
  -p:PublishSingleFile=true -p:DebugType=None -p:DebugSymbols=false \
  --no-restore --output "${publish}"
sudo install -d -o root -g root -m 0755 "${release}"
sudo cp -a -- "${publish}/." "${release}/"
sudo chmod 0755 "${release}/Meme.Origin"

previous="$(readlink -f /opt/meme-origin-dotnet/current 2>/dev/null || true)"
sudo ln -s "${release}" /opt/meme-origin-dotnet/current.new
sudo mv -Tf /opt/meme-origin-dotnet/current.new /opt/meme-origin-dotnet/current
rollback() {
  trap - ERR
  if [[ -n "${previous}" ]]; then
    sudo ln -s "${previous}" /opt/meme-origin-dotnet/current.rollback
    sudo mv -Tf /opt/meme-origin-dotnet/current.rollback /opt/meme-origin-dotnet/current
  else
    sudo unlink /opt/meme-origin-dotnet/current
  fi
  sudo systemctl restart meme-origin-dotnet.service || true
  echo "Install failed; previous .NET release restored." >&2
}
trap rollback ERR
sudo install -o root -g root -m 0644 "${origin}/deploy/meme-origin-dotnet.service" \
  /etc/systemd/system/meme-origin-dotnet.service
sudo systemctl daemon-reload
sudo systemctl enable meme-origin-dotnet.service
sudo systemctl restart meme-origin-dotnet.service
for _ in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8087/healthz >/dev/null; then
    trap - ERR
    echo "meme-origin-dotnet ${release_id} installed on 127.0.0.1:8087."
    exit 0
  fi
  sleep 1
done
false
