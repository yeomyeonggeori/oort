#!/usr/bin/env bash
# Build the runner's box image (ADR-0197 M2, #3505): the S3 image + momo-box-agent (release) + entry + shred
# helper. Prints the image ID (`sha256:<64 hex>`), the form the runner's `image` config field pins.
#   build-image.sh [TAG]      TAG default momo-m2-box:local
# Env: MOMO_M2_BIN_DIR=<dir with a prebuilt Linux momo-box-agent> skips the Rust build.
#      MOMO_M2_RUST_IMAGE (default rust:1-bookworm: glibc 2.36 = the box image's glibc; a build on a
#      newer glibc does not start in the box).
# What runs where: the Rust build runs in a rust container with the source mounted read-only and the
# target + registry on tmpfs (no disk volume, nothing left behind); only `momo-box-agent` is built and
# copied. Every docker object this makes is named momo-m2-* (MOMO_BUILD_NAME renames the build container: verify-m4.sh
# sets momo-m4-build so a run only ever touches its own prefix).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAG="${1:-momo-m2-box:local}"
RUST_IMAGE="${MOMO_M2_RUST_IMAGE:-rust:1-bookworm}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-m2-image.XXXXXX")"
BUILD_NAME="${MOMO_BUILD_NAME:-momo-m2-build}"
trap 'docker rm -f "$BUILD_NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# the S3 base (rebuilt only when its sources changed)
# shellcheck source=momo-s3-box.sh
MOMO_S3_STATE_DIR="$WORK/runner-state" source "$HERE/momo-s3-box.sh"
want="$(src_hash)"
have="$(docker image inspect momo-s3-box:local --format '{{index .Config.Labels "io.momo.s3.src-hash"}}' 2>/dev/null || true)"
if [[ "$have" != "$want" ]]; then
  echo "== base image missing or stale: building momo-s3-box:local" >&2
  "$HERE/momo-s3-box.sh" build >/dev/null 2>&1
fi

BIN="${MOMO_M2_BIN_DIR:-$WORK/bin}"
if [[ -z "${MOMO_M2_BIN_DIR:-}" ]]; then
  mkdir -p "$BIN"
  echo "== building momo-box-agent (release) in $RUST_IMAGE" >&2
  docker rm -f "$BUILD_NAME" >/dev/null 2>&1 || true
  docker run --name "$BUILD_NAME" \
    -v "$ROOT/server-rust":/src:ro \
    --tmpfs /target:rw,exec,size=4g --tmpfs /usr/local/cargo/registry:rw,exec,size=1g \
    -e CARGO_TARGET_DIR=/target -e CARGO_PROFILE_RELEASE_DEBUG=0 -e CARGO_INCREMENTAL=0 -e CARGO_TERM_COLOR=never -w /src \
    "$RUST_IMAGE" sh -c 'cargo build --locked --release -p momo-box-agent --bin momo-box-agent 2>&1 | tail -3 && mkdir -p /out && cp /target/release/momo-box-agent /out/' >&2
  docker cp "$BUILD_NAME":/out/. "$BIN/" >&2
  docker rm -f "$BUILD_NAME" >/dev/null 2>&1
fi
head -c 4 "$BIN/momo-box-agent" | grep -q ELF || { echo "momo-box-agent is not a Linux binary" >&2; exit 1; }

CTX="$WORK/ctx"
mkdir -p "$CTX"
# ONLY these three files enter the image context: the probe never does.
cp "$BIN/momo-box-agent" "$HERE/momo-box-agent-entry" "$HERE/momo-box-volume-shred" "$HERE/Dockerfile.agent" "$CTX/"
agent_sha="$(shasum -a 256 "$CTX/momo-box-agent" | cut -d' ' -f1)"
docker build -q -f "$CTX/Dockerfile.agent" --build-arg "AGENT_SHA=$agent_sha" -t "$TAG" "$CTX" >&2
docker image inspect "$TAG" --format '{{.Id}}'
