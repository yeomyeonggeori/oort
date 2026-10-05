#!/usr/bin/env bash
# shellcheck disable=SC2016
# ADR-0197 M4 verification (#3511): the blind relay against a REAL box container started by the REAL runner.
#
#   server router (this machine, on Postgres)  <-- websocket -->  owner DEVICE (test, software P-256 key)
#        ^                                                          |
#        | outbound only                                            | relay: opaque encrypted frames
#   box-agent in a box container  <-- started by -->  momo-box-runner (Linux binary, root, inside the Colima VM)
#
# Everything it makes is named momo-m4-* (containers, volumes, network, image, the VM's /var/tmp/momo-m4-*) and is
# removed on exit. The shared S3 base image (momo-s3-box:local) is built if missing, like verify-m2/-m3 do.
#   verify-m4.sh                         image checks, then the end-to-end run
#   verify-m4.sh --image-only            image checks only (no PG, no VM needed beyond docker)
#   verify-m4.sh --sabotage probe        must exit non-zero (image-only): the M3 test probe is added to the image
#   verify-m4.sh --sabotage mount-flags  must exit non-zero: the key mount lacks nosuid,nodev, so the box-agent
#                                        (which re-checks the mount table INSIDE the box) refuses to start
#   verify-m4.sh --self-test             GREEN, then every sabotage mode must go RED
# Needs: Colima (docker + a Linux VM with sudo), an isolated PostgreSQL 18 through DATABASE_URL and PGHOST/PGPORT/PGUSER/
# PGDATABASE/PGPASSWORD (see server-rust/bins/momo-box-e2e/tests/docker_pty.rs), cargo.
# Env: MOMO_M4_HOST   the address of THIS machine as the VM and the boxes see it (default: host.lima.internal's address)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/verify-m4.sh"
SABOTAGE=""
IMAGE_ONLY=0
case "${1:-}" in
  --self-test)
    rc=0
    "$SELF" || rc=1
    for m in probe mount-flags; do
      if "$SELF" --sabotage "$m" >/dev/null 2>&1; then echo "SELF-TEST FAIL: sabotage '$m' stayed GREEN"; rc=1
      else echo "SELF-TEST ok: sabotage '$m' is RED"; fi
    done
    exit "$rc" ;;
  --image-only) IMAGE_ONLY=1; shift ;;
esac
if [[ "${1:-}" == "--sabotage" ]]; then SABOTAGE="${2:?mode}"; shift 2; fi
[[ "$SABOTAGE" == "probe" ]] && IMAGE_ONLY=1

TAG="momo-m4-box:verify"
NET="momo-m4-net"
KEYS="/var/tmp/momo-m4-keys"
RUNNER_DIR="/var/tmp/momo-m4-runner"
# A work dir the VM can read too (virtiofs maps the home directory): the Linux runner binary and the test's inputs.
WORK="${HOME}/.cache/momo-m4/run-$$"
FAILS=0
ok()  { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; FAILS=$((FAILS+1)); }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }
vm() { colima ssh -- "$@"; }

cleanup() {
  vm sudo pkill -f "$RUNNER_DIR/momo-box-runner" >/dev/null 2>&1
  # Only momo-m4-* objects, never anything else on a shared Colima.
  # shellcheck disable=SC2046
  docker rm -f $(docker ps -aq --filter name=momo-m4-) >/dev/null 2>&1
  # shellcheck disable=SC2046
  docker volume rm -f $(docker volume ls -q --filter name=momo-m4-) >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker rmi -f "$TAG" "$TAG-sabotage" >/dev/null 2>&1
  vm sudo sh -c "umount $KEYS 2>/dev/null; rm -rf $KEYS $RUNNER_DIR" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK"

echo "== building the runner's box image"
IMAGE_ID="$(MOMO_BUILD_NAME=momo-m4-build "$HERE/build-image.sh" "$TAG")" || { echo "image build failed"; exit 1; }
SUBJECT="$TAG"
if [[ "$SABOTAGE" == "probe" ]]; then
  SUBJECT="$TAG-sabotage"
  CTX="$(mktemp -d "${TMPDIR:-/tmp}/momo-m4-sabotage.XXXXXX")"
  printf 'FROM %s\nUSER root\nRUN cp /usr/local/bin/momo-box-agent /usr/local/bin/momo-box-probe\n' "$TAG" >"$CTX/Dockerfile"
  docker build -q -t "$SUBJECT" "$CTX" >/dev/null || { echo "sabotage build failed"; exit 1; }
  rm -rf "$CTX"
fi

echo "== the image"
inside() { docker run --rm --entrypoint sh "$SUBJECT" -c "$1"; }
check "the M3 test helper momo-box-probe is NOT in the image" \
  inside '! test -e /usr/local/bin/momo-box-probe && [ -z "$(find / -xdev -name "momo-box-probe*" 2>/dev/null)" ]'
check "the runner's inject mount point exists, root-owned, empty and not writable by the person" \
  inside 'test "$(stat -c "%u %g %a" /run/oort-runner)" = "0 0 755" && [ -z "$(ls -A /run/oort-runner)" ]'
check "the entry installs the runner's seal key and restarts the agent on exit 75" \
  bash -c 'grep -q "install-seal-key" "$0" && grep -q "75" "$0"' "$HERE/momo-box-agent-entry"
check "momo-box-agent knows install-seal-key and has no way to name a key path or a dev key file" \
  inside 'momo-box-agent 2>&1 | grep -q "install-seal-key" && ! momo-box-agent 2>&1 | grep -q -- "--dev-key-file"'
check "no setuid/setgid file (D1: the image has none)" \
  inside '[ -z "$(find / -xdev -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null)" ]'

if [[ "$IMAGE_ONLY" == 1 ]]; then
  echo "== $FAILS failing"; [[ "$FAILS" == 0 ]]; exit $?
fi

echo "== the Linux runner binary (built in a rust container; it runs in the VM as root)"
docker rm -f momo-m4-build-runner >/dev/null 2>&1
docker run --name momo-m4-build-runner \
  -v "$ROOT/server-rust":/src:ro \
  --tmpfs /target:rw,exec,size=4g --tmpfs /usr/local/cargo/registry:rw,exec,size=1g \
  -e CARGO_TARGET_DIR=/target -e CARGO_PROFILE_RELEASE_DEBUG=0 -e CARGO_INCREMENTAL=0 -e CARGO_TERM_COLOR=never -w /src \
  "${MOMO_M2_RUST_IMAGE:-rust:1-bookworm}" sh -c 'cargo build --locked --release -p momo-box-runner --bin momo-box-runner 2>&1 | tail -3 && mkdir -p /out && cp /target/release/momo-box-runner /out/' || { echo "runner build failed"; exit 1; }
docker cp momo-m4-build-runner:/out/momo-box-runner "$WORK/momo-box-runner" || { echo "runner copy failed"; exit 1; }
docker rm -f momo-m4-build-runner >/dev/null 2>&1
head -c 4 "$WORK/momo-box-runner" | grep -q ELF || { echo "momo-box-runner is not a Linux binary"; exit 1; }

echo "== the VM: a nosuid,nodev filesystem for the key root, the runner's directory, the box network"
HOST="${MOMO_M4_HOST:-$(vm getent hosts host.lima.internal | awk '{print $1}')}"
[[ -n "$HOST" ]] || { echo "cannot find this machine's address as the VM sees it (set MOMO_M4_HOST)"; exit 1; }
MOUNT_OPTS="nosuid,nodev,noexec,size=64m"
[[ "$SABOTAGE" == "mount-flags" ]] && MOUNT_OPTS="size=64m"   # what a careless host prep would do: no nosuid,nodev
vm sudo sh -c "umount $KEYS 2>/dev/null; rm -rf $KEYS $RUNNER_DIR; mkdir -p $KEYS $RUNNER_DIR && mount -t tmpfs -o $MOUNT_OPTS tmpfs $KEYS && chmod 0755 $KEYS" \
  || { echo "cannot prepare the VM"; exit 1; }
docker network rm "$NET" >/dev/null 2>&1
docker network create --driver bridge -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null || { echo "network create failed"; exit 1; }
check "the key root is a separate filesystem (tmpfs here) and carries the flags this run asked for" \
  bash -c 'opts=$(colima ssh -- findmnt -no OPTIONS "$0"); echo "$opts"; if [ "$1" = mount-flags ]; then ! grep -q nosuid <<<"$opts"; else grep -q nosuid <<<"$opts" && grep -q nodev <<<"$opts"; fi' "$KEYS" "$SABOTAGE"

echo "== the end-to-end run (server ↔ owner device ↔ relay ↔ box in a container, started by the runner)"
: "${DATABASE_URL:?set DATABASE_URL (and PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD) for an isolated PostgreSQL 18}"
if ( cd "$ROOT/server-rust" \
  && MOMO_M4_E2E_IMAGE="$IMAGE_ID" MOMO_M4_E2E_RUNNER="$WORK/momo-box-runner" MOMO_M4_E2E_NETWORK="$NET" \
     MOMO_M4_E2E_HOST="$HOST" MOMO_M4_E2E_KEYS="$KEYS" MOMO_M4_E2E_RUNNER_DIR="$RUNNER_DIR" MOMO_M4_E2E_WORK="$WORK" \
     cargo test -p momo-box-e2e --test docker_pty -- --ignored --nocapture --test-threads=1 ); then
  ok "the e2e run: runner creates the box, the box registers and is attested, the owner pins and attaches, types and reads, no plaintext on the server, revoke ends the session, stop/start keeps the host key, a dead spawn helper is replaced, delete shreds the keys"
else
  bad "the e2e run"
fi
echo "== $FAILS failing"
[[ "$FAILS" == 0 ]]
