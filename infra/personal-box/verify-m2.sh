#!/usr/bin/env bash
# shellcheck disable=SC2016
# ADR-0197 M2 verification (#3505): the runner's box image, and the real end-to-end run
# (server router ↔ real momo-box-runner ↔ real Docker). Everything it makes is named momo-m2-* and removed on exit.
#   verify-m2.sh                       image checks, then the e2e run
#   verify-m2.sh --image-only          image checks only (no PG needed)
#   verify-m2.sh --sabotage probe      must exit non-zero: the M3 test probe is added to the image
#   verify-m2.sh --self-test           GREEN, then the sabotage must go RED
# The e2e run needs an isolated PostgreSQL 18 reachable through DATABASE_URL/PG* (see server-rust/bins/
# momo-server/tests/box_runner_e2e.rs) and a built runner: this script builds both the image and the runner.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/verify-m2.sh"
SABOTAGE=""
IMAGE_ONLY=0
case "${1:-}" in
  --self-test)
    rc=0
    "$SELF" --image-only || rc=1
    if "$SELF" --image-only --sabotage probe >/dev/null 2>&1; then echo "SELF-TEST FAIL: sabotage 'probe' stayed GREEN"; rc=1
    else echo "SELF-TEST ok: sabotage 'probe' is RED"; fi
    exit "$rc" ;;
  --image-only) IMAGE_ONLY=1; shift ;;
esac
if [[ "${1:-}" == "--sabotage" ]]; then SABOTAGE="${2:?mode}"; shift 2; fi
if [[ "${1:-}" == "--image-only" ]]; then IMAGE_ONLY=1; shift; fi

TAG="momo-m2-box:verify"
NET="momo-m2-net"
FAILS=0
ok()  { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; FAILS=$((FAILS+1)); }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

cleanup() {
  docker rm -f momo-m2-verify >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker rmi -f "$TAG" "$TAG-sabotage" >/dev/null 2>&1
}
trap cleanup EXIT

echo "== building the runner's box image"
IMAGE_ID="$("$HERE/build-image.sh" "$TAG")" || { echo "image build failed"; exit 1; }
SUBJECT="$TAG"

if [[ "$SABOTAGE" == "probe" ]]; then
  # What a careless image build would do: ship the M3 test probe. The checks below must notice.
  SUBJECT="$TAG-sabotage"
  CTX="$(mktemp -d "${TMPDIR:-/tmp}/momo-m2-sabotage.XXXXXX")"
  printf 'FROM %s\nUSER root\nRUN cp /usr/local/bin/momo-box-agent /usr/local/bin/momo-box-probe\n' "$TAG" >"$CTX/Dockerfile"
  docker build -q -t "$SUBJECT" "$CTX" >/dev/null || { echo "sabotage build failed"; exit 1; }
  rm -rf "$CTX"
fi

echo "== the image"
inside() { docker run --rm --entrypoint sh "$SUBJECT" -c "$1"; }
check "momo-box-agent, the entry and the overwrite helper are present and executable" \
  inside 'test -x /usr/local/bin/momo-box-agent && test -x /usr/local/bin/momo-box-agent-entry && test -x /usr/local/bin/momo-box-volume-shred'
check "the M3 test helper momo-box-probe is NOT in the image (not at that path, not under any name)" \
  inside '! test -e /usr/local/bin/momo-box-probe && [ -z "$(find / -xdev -name "momo-box-probe*" 2>/dev/null)" ]'
check "the only momo binaries added over the S3 image are the agent and its two scripts" \
  bash -c '[ "$(docker run --rm --entrypoint sh "$0" -c "ls /usr/local/bin | grep -E \"^momo-box-(agent|probe|runner)\" | sort | tr \"\\n\" \" \"")" = "momo-box-agent momo-box-agent-entry " ]' "$SUBJECT"
check "no setuid/setgid file (D1: the image has none)" \
  inside '[ -z "$(find / -xdev -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null)" ]'
check "momo-box-agent is the binary the label says" \
  bash -c 'want=$(docker image inspect "$0" --format "{{index .Config.Labels \"io.momo.m2.agent-sha\"}}"); have=$(docker run --rm --entrypoint sh "$0" -c "sha256sum /usr/local/bin/momo-box-agent" | cut -d" " -f1); [ -n "$want" ] && [ "$want" = "$have" ]' "$SUBJECT"
check "the box marker and the agent/person accounts of S3/M3 are intact" \
  inside 'test "$(stat -c "%u %a" /etc/oort-box)" = "0 644" && id box-agent | grep -q uid=10002 && id box | grep -q uid=10001'
check "momo-box-agent runs in the box libc" inside 'momo-box-agent --version | grep -q momo-box-agent'
check "no Claude ACP adapter and no credentials in the image" \
  inside '! ls /opt/tools/node_modules 2>/dev/null | grep -q . && [ -z "$(find / -xdev \( -name .credentials.json -o -name auth.json \) 2>/dev/null)" ]'
check "the entry script starts the agent as uid 10002 with only setuid/setgid ambient" \
  grep -q -- '--reuid $AGENT_UID' "$HERE/momo-box-agent-entry"

if [[ "$IMAGE_ONLY" == 1 ]]; then
  echo "== $FAILS failing"; [[ "$FAILS" == 0 ]]; exit $?
fi

echo "== the end-to-end run (server ↔ runner ↔ Docker)"
docker network rm "$NET" >/dev/null 2>&1
docker network create --driver bridge -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null || { echo "network create failed"; exit 1; }
( cd "$ROOT/server-rust" && cargo build -p momo-box-runner >/dev/null 2>&1 ) || { echo "runner build failed"; exit 1; }
: "${DATABASE_URL:?set DATABASE_URL (and PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD) for an isolated PostgreSQL 18}"
if ( cd "$ROOT/server-rust" \
  && MOMO_M2_E2E_IMAGE="$IMAGE_ID" MOMO_M2_E2E_RUNNER="$ROOT/server-rust/target/debug/momo-box-runner" MOMO_M2_E2E_NETWORK="$NET" \
     cargo test -p momo-server --test box_runner_e2e -- --ignored --nocapture --test-threads=1 ); then
  ok "the e2e run: create, start, stop, restart, orphan quarantine and shred, delete with verification, nothing left"
else
  bad "the e2e run"
fi
echo "== $FAILS failing"
[[ "$FAILS" == 0 ]]
