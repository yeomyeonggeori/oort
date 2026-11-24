#!/usr/bin/env bash
# Pre-publish check for the pinned ONNX Runtime source image (#6012).
#
# server-rust/Dockerfile's `ort-payload` stage takes its library from `ORT_OWN_IMAGE` (an already
# published oort app image, pinned by digest) in every build that uses ORT_SOURCE=own-image, which is
# the default. If that digest is deleted or made private, those builds all stop. This reads the pin
# and asks the registry, anonymously, whether the manifest is still there. Exit 0 = readable.
#
# Usage: scripts/check_ort_own_image.sh [--dockerfile FILE] [--registry URL] [--parse-only]
#   --registry   override https://ghcr.io (the test points it at a local stub)
#   --parse-only only check that the pin is a digest and print it (no network)
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/server-rust/Dockerfile"
REGISTRY=""
PARSE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dockerfile) DOCKERFILE="${2:?--dockerfile needs a file}"; shift 2 ;;
    --registry) REGISTRY="${2:?--registry needs a URL}"; shift 2 ;;
    --parse-only) PARSE_ONLY=1; shift ;;
    *) echo "[ort-own-image] unknown argument: $1" >&2; exit 2 ;;
  esac
done

ref="$(sed -n 's/^ARG ORT_OWN_IMAGE=//p' "$DOCKERFILE")"
if ! printf '%s\n' "$ref" | grep -Eq '^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'; then
  echo "[ort-own-image] FAIL: ORT_OWN_IMAGE is not a digest-pinned reference: '$ref'" >&2
  exit 1
fi
host="${ref%%/*}"
rest="${ref#*/}"
repo="${rest%@*}"
digest="${ref##*@}"
if [ "$PARSE_ONLY" = 1 ]; then
  echo "$ref"
  exit 0
fi
[ -n "$REGISTRY" ] || REGISTRY="https://$host"

tok="$(curl -fsS --max-time 30 "$REGISTRY/token?scope=repository:$repo:pull" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')" \
  || { echo "[ort-own-image] FAIL: no anonymous pull token from $REGISTRY for $repo" >&2; exit 1; }
if curl -fsSI --max-time 30 -o /dev/null \
  -H "Authorization: Bearer $tok" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  "$REGISTRY/v2/$repo/manifests/$digest"; then
  echo "[ort-own-image] ok: $repo@$digest is readable"
else
  echo "[ort-own-image] FAIL: $repo@$digest is not readable on $REGISTRY — move ORT_OWN_IMAGE to another release or default ORT_SOURCE to upstream (docs/RELEASING.md)" >&2
  exit 1
fi
