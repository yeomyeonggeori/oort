#!/usr/bin/env bash
# Generate releases/latest.json from a published GitHub Release tag (SH-1 / #1954).
#
# Reads the Release body for the operator list-digest pins, then queries GHCR
# (buildx imagetools, or docker manifest inspect) for the linux/amd64 and
# linux/arm64 image-manifest digests inside that list. Does not invent digests.
set -euo pipefail

ROOT=""
OUTPUT=""
REPO="yeomyeonggeori/oort"
TAG=""

APP_IMAGE="ghcr.io/yeomyeonggeori/oort"
PG_IMAGE="ghcr.io/yeomyeonggeori/oort-postgres"
DIGEST_RE='^sha256:[0-9a-f]{64}$'
SLSA_V1='https://slsa.dev/provenance/v1'

usage() {
  cat <<'EOF'
Usage: scripts/release_manifest.sh <tag> [--repo owner/name] [--output PATH] [--root DIR]

  <tag>            GitHub Release tag (v0.1.4 or 0.1.4)
  --repo owner/name  Default: yeomyeonggeori/oort
  --output PATH    Where to write JSON. Default: <root>/releases/latest.json
  --root DIR       Repository root. Default: the enclosing git worktree root.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      echo "[release-manifest] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$TAG" ]; then
        echo "[release-manifest] unexpected extra argument: $1" >&2
        usage >&2
        exit 2
      fi
      TAG="$1"
      shift
      ;;
  esac
done

if [ -z "$TAG" ]; then
  usage >&2
  exit 2
fi

case "$TAG" in
  v*) ;;
  *) TAG="v$TAG" ;;
esac

if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "[release-manifest] not inside a git worktree; pass --root DIR" >&2
    exit 1
  }
fi
ROOT="$(CDPATH='' cd -- "$ROOT" && pwd)"

if [ -z "$OUTPUT" ]; then
  OUTPUT="$ROOT/releases/latest.json"
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[release-manifest] $1 is required (not found on PATH)" >&2
    exit 1
  fi
}

need jq
need gh
need docker

# gh colorizes --json even when stdout is not a TTY if CLICOLOR=1.
export GH_FORCE_TTY=0
export CLICOLOR=0
export NO_COLOR=1

fail() {
  echo "[release-manifest] FAIL: $*" >&2
  exit 1
}

require_digest() {
  local label="$1"
  local value="$2"
  printf '%s\n' "$value" | grep -Eq "$DIGEST_RE" ||
    fail "$label is not $DIGEST_RE: $value"
}

# Resolve `docker buildx imagetools` even when the CLI plugin is not on PATH
# (Docker Desktop ships it under Docker.app/Contents/Resources/cli-plugins).
run_imagetools() {
  if docker buildx version >/dev/null 2>&1; then
    docker buildx imagetools inspect "$@"
    return
  fi
  local plugin
  for plugin in \
    /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx \
    /usr/libexec/docker/cli-plugins/docker-buildx \
    "$HOME/.docker/cli-plugins/docker-buildx"; do
    if [ -x "$plugin" ]; then
      "$plugin" imagetools inspect "$@"
      return
    fi
  done
  return 1
}

# Print list digest, amd64 image-manifest digest, arm64 image-manifest digest.
inspect_list() {
  local pin="$1"
  local json list amd64 arm64

  if json="$(run_imagetools --format '{{json .}}' "$pin" 2>/dev/null)" &&
    [ -n "$json" ]; then
    list="$(printf '%s\n' "$json" | jq -er '.manifest.digest // empty')"
    amd64="$(printf '%s\n' "$json" | jq -er '
      [.manifest.manifests[]?
        | select(.platform.os == "linux" and .platform.architecture == "amd64")
        | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
        | .digest] | first // empty')"
    arm64="$(printf '%s\n' "$json" | jq -er '
      [.manifest.manifests[]?
        | select(.platform.os == "linux" and .platform.architecture == "arm64")
        | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
        | .digest] | first // empty')"
  else
    json="$(docker manifest inspect "$pin")" ||
      fail "docker manifest inspect failed for $pin"
    list="${pin##*@}"
    amd64="$(printf '%s\n' "$json" | jq -er '
      [.manifests[]?
        | select(.platform.os == "linux" and .platform.architecture == "amd64")
        | .digest] | first // empty')"
    arm64="$(printf '%s\n' "$json" | jq -er '
      [.manifests[]?
        | select(.platform.os == "linux" and .platform.architecture == "arm64")
        | .digest] | first // empty')"
  fi

  require_digest "$pin list" "$list"
  require_digest "$pin amd64" "$amd64"
  require_digest "$pin arm64" "$arm64"
  [ "$list" != "$amd64" ] || fail "$pin list digest equals amd64 digest"
  [ "$list" != "$arm64" ] || fail "$pin list digest equals arm64 digest"
  [ "$amd64" != "$arm64" ] || fail "$pin amd64 digest equals arm64 digest"
  printf '%s %s %s\n' "$list" "$amd64" "$arm64"
}

first_pin() {
  local image="$1"
  local body="$2"
  local pin
  pin="$(printf '%s\n' "$body" | grep -Eo "${image}@sha256:[0-9a-f]{64}" | head -n 1 || true)"
  [ -n "$pin" ] || fail "Release body has no ${image}@sha256:<64 hex> pin"
  printf '%s\n' "$pin"
}

echo "[release-manifest] reading GitHub Release $TAG ($REPO)"
release_json="$(
  GH_FORCE_TTY=0 CLICOLOR=0 NO_COLOR=1 \
    gh release view "$TAG" --repo "$REPO" --json tagName,publishedAt,url,body
)" || fail "gh release view $TAG failed"

published="$(printf '%s\n' "$release_json" | jq -er '.publishedAt')"
released_at="$(printf '%s\n' "$published" | cut -c1-10)"
release_url="$(printf '%s\n' "$release_json" | jq -er '.url')"
body="$(printf '%s\n' "$release_json" | jq -er '.body')"

app_pin="$(first_pin "$APP_IMAGE" "$body")"
pg_pin="$(first_pin "$PG_IMAGE" "$body")"

echo "[release-manifest] inspecting $app_pin"
app_row="$(inspect_list "$app_pin")"
echo "[release-manifest] inspecting $pg_pin"
pg_row="$(inspect_list "$pg_pin")"

app_list="${app_row%% *}"
app_rest="${app_row#* }"
app_amd64="${app_rest%% *}"
app_arm64="${app_rest#* }"

pg_list="${pg_row%% *}"
pg_rest="${pg_row#* }"
pg_amd64="${pg_rest%% *}"
pg_arm64="${pg_rest#* }"

# The Release body pin is the operator list digest; GHCR must agree.
[ "$app_list" = "${app_pin##*@}" ] ||
  fail "GHCR list digest $app_list != Release pin ${app_pin##*@}"
[ "$pg_list" = "${pg_pin##*@}" ] ||
  fail "GHCR postgres list digest $pg_list != Release pin ${pg_pin##*@}"

verify_cmd="gh attestation verify \"oci://${APP_IMAGE}@${app_list}\" --repo ${REPO} --predicate-type ${SLSA_V1}"

mkdir -p "$(dirname "$OUTPUT")"
tmp="${OUTPUT}.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM

jq -n \
  --arg version "$TAG" \
  --arg released_at "$released_at" \
  --arg app_ref "$APP_IMAGE" \
  --arg app_list "$app_list" \
  --arg app_amd64 "$app_amd64" \
  --arg app_arm64 "$app_arm64" \
  --arg pg_ref "$PG_IMAGE" \
  --arg pg_list "$pg_list" \
  --arg pg_amd64 "$pg_amd64" \
  --arg pg_arm64 "$pg_arm64" \
  --arg verify_cmd "$verify_cmd" \
  --arg release_url "$release_url" \
  '{
    version: $version,
    released_at: $released_at,
    images: {
      app: {
        ref: $app_ref,
        digest_list: $app_list,
        digests: {
          amd64: $app_amd64,
          arm64: $app_arm64
        }
      },
      postgres: {
        ref: $pg_ref,
        digest_list: $pg_list,
        digests: {
          amd64: $pg_amd64,
          arm64: $pg_arm64
        }
      }
    },
    attestation: {
      verify_cmd: $verify_cmd
    },
    sources: {
      release_url: $release_url
    }
  }' >"$tmp"

mv "$tmp" "$OUTPUT"
trap - EXIT INT TERM

echo "[release-manifest] wrote $OUTPUT ($TAG)"
echo "[release-manifest] app list $app_list"
echo "[release-manifest] postgres list $pg_list"
