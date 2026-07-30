#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repository="${MEME_GITHUB_REPOSITORY:-}"
ref="${MEME_GITHUB_REF:-main}"
target="${MEME_INSTALL_ROOT:-/volume1/docker/meme-origin}"

usage() {
  echo "Usage: install-from-github.sh --repo OWNER/REPO [--ref REF] [--target /volume1/docker/NAME]"
}

while (($#)); do
  case "$1" in
    --repo) repository="${2:?--repo requires OWNER/REPO}"; shift 2 ;;
    --ref) ref="${2:?--ref requires a value}"; shift 2 ;;
    --target) target="${2:?--target requires a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  { echo "A valid --repo OWNER/REPO is required." >&2; exit 1; }
[[ "${ref}" =~ ^[A-Za-z0-9._/-]+$ && "${ref}" != *".."* ]] ||
  { echo "Invalid ref." >&2; exit 1; }
[[ "${target}" == /volume1/docker/* && "${target}" != /volume1/docker/ ]] ||
  { echo "Target must be a named directory below /volume1/docker." >&2; exit 1; }

for command in curl unzip openssl find; do
  command -v "${command}" >/dev/null ||
    { echo "Missing command: ${command}" >&2; exit 1; }
done

work="$(mktemp -d "/tmp/meme-origin-zip.XXXXXXXX")"
cleanup() {
  case "${work}" in
    /tmp/meme-origin-zip.*) rm -rf -- "${work}" ;;
  esac
}
trap cleanup EXIT

archive="${work}/repository.zip"
url="https://github.com/${repository}/archive/${ref}.zip"
echo "Downloading ${repository}@${ref} without Git..."
curl --fail --location --retry 3 --output "${archive}" "${url}"
unzip -q "${archive}" -d "${work}/unpacked"
mapfile -t manifests < <(find "${work}/unpacked" -type f -path '*/origin/package.json')
[[ "${#manifests[@]}" -eq 1 ]] ||
  { echo "Archive must contain exactly one origin/package.json." >&2; exit 1; }
source_dir="$(dirname "${manifests[0]}")"
for required in package.json package-lock.json Dockerfile compose.yaml .dockerignore .env.example src; do
  [[ -e "${source_dir}/${required}" ]] ||
    { echo "Archive is missing origin/${required}." >&2; exit 1; }
done

mkdir -p -- "${target}" "${target}/data" "${target}/logs" "${target}/backups"
target_real="$(realpath "${target}")"
[[ "${target_real}" == /volume1/docker/* && "${target_real}" != /volume1/docker/ ]] ||
  { echo "Resolved target escaped /volume1/docker." >&2; exit 1; }

stamp="$(date -u +%Y%m%d%H%M%S)-$$"
backup="${target}/backups/${stamp}"
mkdir -p -- "${backup}"
for item in package.json package-lock.json Dockerfile compose.yaml .dockerignore .env.example src; do
  if [[ -e "${target}/${item}" ]]; then mv -- "${target}/${item}" "${backup}/${item}"; fi
  cp -a -- "${source_dir}/${item}" "${target}/${item}"
done

if [[ ! -f "${target}/.env" ]]; then
  token="$(openssl rand -hex 32)"
  sed \
    -e "s|replace-with-at-least-32-random-characters|${token}|" \
    -e "s|^PUID=.*|PUID=$(id -u)|" \
    -e "s|^PGID=.*|PGID=$(id -g)|" \
    -e "s|^MEME_HOST_ROOT=.*|MEME_HOST_ROOT=${target_real}|" \
    "${source_dir}/.env.example" >"${target}/.env"
  chmod 0600 "${target}/.env"
  unset token
fi

echo "Installed project files in ${target_real}."
echo "In Synology Container Manager, add a Project using ${target_real}/compose.yaml."
echo "On update, rebuild and recreate the project; .env, data, and logs are preserved."
