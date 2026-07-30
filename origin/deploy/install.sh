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
for command in git node npm sudo systemctl curl openssl realpath getent groupadd useradd ldd awk install mktemp; do
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
  [[ -f "${clone}/origin/package.json" && -f "${clone}/origin/deploy/install.sh" ]] || exit 1
}
if [[ "${MEME_INSTALL_REEXEC:-0}" != "1" ]]; then
  prepare_repo
  exec env MEME_INSTALL_REEXEC=1 MEME_REPO_URL="${repo_url}" bash "${clone}/origin/deploy/install.sh" --no-pull
fi
prepare_repo
origin="$(realpath -e "${clone}/origin")"
[[ "${origin}" == "${clone}/origin" ]] || exit 1

arch="$(uname -m)"
[[ "${arch}" == "x86_64" ]] || { echo "Unsupported architecture ${arch}; expected x86_64." >&2; exit 1; }
node_real="$(realpath -e "$(command -v node)")"
npm_real="$(realpath -e "$(command -v npm)")"
[[ -x "${node_real}" ]] || { echo "Resolved Node executable is not executable: ${node_real}" >&2; exit 1; }
[[ -x "${npm_real}" ]] || { echo "Resolved npm executable is not executable: ${npm_real}" >&2; exit 1; }
node -e 'const [major]=process.versions.node.split(".").map(Number); if(major!==24) process.exit(1)' ||
  { echo "Node >=24 and <25 is required; found $(node --version)." >&2; exit 1; }
glibc="$(ldd --version 2>&1 | awk 'NR==1{print $NF}')"
echo "Preflight: node=$(node --version), arch=${arch}, glibc=${glibc} (sharp 0.35.3 linux-x64 requires glibc >=2.28)."
awk -v v="${glibc}" 'BEGIN{split(v,a,"."); exit !(a[1]>2 || (a[1]==2 && a[2]>=28))}' ||
  { echo "glibc ${glibc} is too old for sharp 0.35.3; use the bookworm Container Manager deployment." >&2; exit 1; }
[[ -f "${origin}/package-lock.json" ]] || { echo "package-lock.json is required." >&2; exit 1; }

sudo -v
for pair in "meme-origin:group" "meme-origin:user"; do
  name="${pair%%:*}"; kind="${pair##*:}"
  if [[ "${kind}" == group ]] && ! getent group "${name}" >/dev/null; then sudo groupadd --system "${name}"; fi
  if [[ "${kind}" == user ]] && ! getent passwd "${name}" >/dev/null; then
    sudo useradd --system --gid "${name}" --home-dir /var/lib/meme-origin --shell /usr/sbin/nologin "${name}"
  fi
done
sudo install -d -o meme-origin -g meme-origin -m 0750 /var/lib/meme-origin /var/log/meme-origin
sudo install -d -o root -g root -m 0755 /opt/meme-origin /opt/meme-origin/releases
sudo ln -sfn "${node_real}" /opt/meme-origin/node.new
sudo mv -Tf /opt/meme-origin/node.new /opt/meme-origin/node
sudo install -d -o root -g meme-origin -m 0750 /etc/meme-origin
env_file=/etc/meme-origin/meme-origin.env
if ! sudo test -f "${env_file}"; then
  token="$(openssl rand -hex 32)"
  temp_env="$(mktemp /tmp/meme-origin-env.XXXXXXXX)"
  trap 'rm -f -- "${temp_env:-}"' EXIT
  sed "s/replace-with-at-least-32-random-characters/${token}/" "${origin}/deploy/meme-origin.env.example" >"${temp_env}"
  chmod 0600 "${temp_env}"
  sudo install -o root -g root -m 0600 "${temp_env}" "${env_file}"
  unset token
fi

release_id="$(date -u +%Y%m%d%H%M%S)-$(git -C "${clone}" rev-parse --short=12 HEAD)"
release="/opt/meme-origin/releases/${release_id}"
sudo install -d -o root -g root -m 0755 "${release}" "${release}/src"
sudo cp -a -- "${origin}/package.json" "${origin}/package-lock.json" "${release}/"
sudo cp -a -- "${origin}/src/." "${release}/src/"
sudo env "PATH=$(dirname "${node_real}"):/usr/local/bin:/usr/bin:/bin" \
  "${npm_real}" ci --omit=dev --ignore-scripts=false --prefix "${release}"
sudo /opt/meme-origin/node -e "import('${release}/node_modules/sharp/lib/index.js').then(()=>console.log('sharp load check passed')).catch(e=>{console.error(e);process.exit(1)})"

previous="$(readlink -f /opt/meme-origin/current 2>/dev/null || true)"
sudo ln -s "${release}" /opt/meme-origin/current.new
sudo mv -Tf /opt/meme-origin/current.new /opt/meme-origin/current
rollback() {
  trap - ERR
  if [[ -n "${previous}" ]]; then
    sudo ln -s "${previous}" /opt/meme-origin/current.rollback
    sudo mv -Tf /opt/meme-origin/current.rollback /opt/meme-origin/current
  fi
  sudo systemctl restart meme-origin.service || true
  echo "Install failed; previous release restored." >&2
}
trap rollback ERR
sudo install -o root -g root -m 0644 "${origin}/deploy/meme-origin.service" /etc/systemd/system/meme-origin.service
sudo systemctl daemon-reload
sudo systemctl enable meme-origin.service
sudo systemctl restart meme-origin.service
for _ in {1..20}; do
  curl --fail --silent --max-time 2 http://127.0.0.1:8086/healthz >/dev/null && { trap - ERR; echo "meme-origin ${release_id} installed."; exit 0; }
  sleep 1
done
false
