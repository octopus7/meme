#!/bin/sh
set -eu

repository="${MEME_GITHUB_REPOSITORY:-octopus7/meme}"
ref="${MEME_GITHUB_REF:-main}"
target="${MEME_INSTALL_ROOT:-/volume1/docker/meme-origin}"

usage() {
  echo "Usage: install-from-github.sh [--repo OWNER/REPO] [--ref REF] [--target /volume1/docker/NAME]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; repository="$2"; shift 2 ;;
    --ref) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; ref="$2"; shift 2 ;;
    --target) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; target="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$repository" in
  */*) ;;
  *) echo "Repository must use OWNER/REPO format." >&2; exit 1 ;;
esac
case "$repository" in *[!A-Za-z0-9_.\/-]*) echo "Invalid repository." >&2; exit 1 ;; esac
case "$ref" in ""|*[!A-Za-z0-9._\/-]*|*".."*) echo "Invalid ref." >&2; exit 1 ;; esac
case "$target" in
  /volume[0-9]*/docker/) echo "Target must include a project directory name." >&2; exit 1 ;;
  /volume[0-9]*/docker/*) ;;
  *) echo "Target must be a named directory below /volumeN/docker." >&2; exit 1 ;;
esac
case "$target" in *"/../"*|*"/.."|*"/./"*|*"/.") echo "Invalid target." >&2; exit 1 ;; esac

for command in curl tar openssl sed id mktemp date mkdir mv cp rm chmod dirname; do
  command -v "$command" >/dev/null 2>&1 ||
    { echo "Missing command: $command" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/meme-origin.XXXXXXXX")"
cleanup() {
  case "$work" in
    /tmp/meme-origin.*|*/meme-origin.*) rm -rf "$work" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

archive="$work/repository.tar.gz"
unpacked="$work/unpacked"
mkdir -p "$unpacked"
url="https://github.com/${repository}/archive/refs/heads/${ref}.tar.gz"
echo "Downloading ${repository}@${ref} without Git..."
curl --fail --location --retry 3 --output "$archive" "$url"
tar -xzf "$archive" -C "$unpacked"

set -- "$unpacked"/*/origin/package.json
[ "$#" -eq 1 ] && [ -f "$1" ] ||
  { echo "Archive must contain one origin/package.json." >&2; exit 1; }
source_dir="$(dirname "$1")"
for required in package.json package-lock.json Dockerfile compose.yaml .dockerignore .env.example src; do
  [ -e "$source_dir/$required" ] ||
    { echo "Archive is missing origin/$required." >&2; exit 1; }
done

mkdir -p "$target" "$target/data" "$target/logs" "$target/backups"
stamp="$(date -u +%Y%m%d%H%M%S)"
backup="$target/backups/$stamp"
mkdir -p "$backup"

for item in package.json package-lock.json Dockerfile compose.yaml .dockerignore .env.example src; do
  if [ -e "$target/$item" ]; then mv "$target/$item" "$backup/$item"; fi
  cp -R "$source_dir/$item" "$target/$item"
done

if [ ! -f "$target/.env" ]; then
  token="$(openssl rand -hex 32)"
  sed \
    -e "s|replace-with-at-least-32-random-characters|${token}|" \
    -e "s|^PUID=.*|PUID=$(id -u)|" \
    -e "s|^PGID=.*|PGID=$(id -g)|" \
    -e "s|^MEME_HOST_ROOT=.*|MEME_HOST_ROOT=${target}|" \
    "$source_dir/.env.example" >"$target/.env"
  chmod 0600 "$target/.env"
  unset token
fi

echo "Installed project files in $target."
echo "Create or rebuild the Container Manager project using $target/compose.yaml."
echo ".env, data, and logs are preserved during updates."
