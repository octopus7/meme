#!/bin/sh
set -eu

repository="${MEME_GITHUB_REPOSITORY:-octopus7/meme}"
ref="${MEME_GITHUB_REF:-main}"
target="${MEME_INSTALL_ROOT:-/volume1/docker/meme-origin}"
health_url="${MEME_HEALTH_URL:-http://127.0.0.1:8086/healthz}"

usage() {
  echo "Usage: deploy-latest-from-github.sh [--repo OWNER/REPO] [--ref REF] [--target /volumeN/docker/NAME]"
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

commit_api_url="https://api.github.com/repos/${repository}/commits/${ref}"

for command in curl docker grep mktemp rm sed; do
  command -v "$command" >/dev/null 2>&1 ||
    { echo "Missing command: $command" >&2; exit 1; }
done

use_sudo=false
if docker info >/dev/null 2>&1; then
  :
elif command -v sudo >/dev/null 2>&1 &&
     sudo -v &&
     sudo docker info >/dev/null 2>&1; then
  use_sudo=true
else
  echo "Cannot access the Docker daemon as $(id -un)." >&2
  echo "Run this script from an account allowed to use Docker or grant sudo access." >&2
  exit 1
fi

if [ "$use_sudo" = true ]; then
  if sudo docker compose version >/dev/null 2>&1; then
    compose() { sudo docker compose "$@"; }
  elif command -v docker-compose >/dev/null 2>&1 &&
       sudo docker-compose version >/dev/null 2>&1; then
    compose() { sudo docker-compose "$@"; }
  else
    echo "Docker Compose is not available." >&2
    exit 1
  fi
else
  if docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
  elif command -v docker-compose >/dev/null 2>&1 &&
       docker-compose version >/dev/null 2>&1; then
    compose() { docker-compose "$@"; }
  else
    echo "Docker Compose is not available." >&2
    exit 1
  fi
fi

installer="$(mktemp "${TMPDIR:-/tmp}/install-meme-origin.XXXXXXXX")"
cleanup() {
  case "$installer" in
    /tmp/install-meme-origin.*|*/install-meme-origin.*) rm -f "$installer" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

installer_url="https://raw.githubusercontent.com/${repository}/${ref}/origin/docker/install-from-github.sh"

echo "Downloading the installer for ${repository}@${ref}..."
curl --fail --location --retry 3 --output "$installer" "$installer_url"

echo "Resolving commit SHA for ${repository}@${ref}..."
commit_sha="$(curl --fail --silent --show-error --location --retry 3 \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$commit_api_url" \
  | sed -n 's/^[[:space:]]*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' \
  | sed -n '1p')"
case "$commit_sha" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) echo "Could not resolve a commit SHA from GitHub." >&2; exit 1 ;;
esac
echo "Deploying commit ${commit_sha}..."

echo "Updating application files from ${repository}@${ref}..."
sh "$installer" --repo "$repository" --ref "$ref" --target "$target"

if grep -q '^MEME_ORIGIN_COMMIT_SHA=' "$target/.env"; then
  sed -i "s/^MEME_ORIGIN_COMMIT_SHA=.*/MEME_ORIGIN_COMMIT_SHA=$commit_sha/" "$target/.env"
else
  printf '\nMEME_ORIGIN_COMMIT_SHA=%s\n' "$commit_sha" >> "$target/.env"
fi

cd "$target"

# Build before replacing the running container. If the build fails, the old
# container remains online.
echo "Building the latest origin image..."
compose build --pull

echo "Recreating the origin container..."
compose up -d --no-build

echo "Waiting for ${health_url}..."
attempt=1
while [ "$attempt" -le 20 ]; do
  if health_response="$(curl --fail --silent --show-error "$health_url")"; then
    echo "Deployment completed successfully: ${health_response}"
    compose ps
    exit 0
  fi

  if [ "$attempt" -eq 20 ]; then
    break
  fi

  sleep 3
  attempt=$((attempt + 1))
done

echo "Deployment finished, but the health check failed." >&2
compose ps >&2
compose logs --tail 100 meme-origin >&2 || true
exit 1
