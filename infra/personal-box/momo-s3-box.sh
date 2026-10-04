#!/usr/bin/env bash
# Local runner for the S3 spike box (ADR-0197 D1/D8, #3410). No networking/relay wiring.
#   momo-s3-box.sh build                 build image momo-s3-box:local
#   momo-s3-box.sh up [--persist-login]  start detached box (credentials on tmpfs unless --persist-login)
#   momo-s3-box.sh shell                 interactive shell in the running box
#   momo-s3-box.sh audit                 leak scan of logs/runner paths against /cred secrets (stays inside the box)
#   momo-s3-box.sh down [--purge]        stop+remove the box; --purge also removes the credential volume
# Everything is named momo-s3-*. The runner log records verbs only, never terminal output.
set -euo pipefail

MOMO_S3_IMAGE="${MOMO_S3_IMAGE:-momo-s3-box:local}"
MOMO_S3_NAME="${MOMO_S3_NAME:-momo-s3-box}"
MOMO_S3_CRED_VOLUME="${MOMO_S3_CRED_VOLUME:-momo-s3-cred}"
MOMO_S3_STATE_DIR="${MOMO_S3_STATE_DIR:-${TMPDIR:-/tmp}/momo-s3-runner}"
# ADR-0197 D8: docker log driver `none` so a TTY login (URL/code on screen) is never persisted by docker.
MOMO_S3_LOG_DRIVER="${MOMO_S3_LOG_DRIVER:-none}"
MOMO_S3_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

runner_log() { mkdir -p "$MOMO_S3_STATE_DIR"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$MOMO_S3_STATE_DIR/runner.log"; }

# Prints one docker-run argument per line (fixed template; no env/secrets).
box_run_args() {
  local persist="$1"
  local cred_mount
  if [[ "$persist" == "1" ]]; then
    cred_mount="${MOMO_S3_CRED_VOLUME}:/cred"
    printf '%s\n' -v "$cred_mount"
  else
    printf '%s\n' --tmpfs "/cred:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001"
  fi
  printf '%s\n' \
    --init \
    --read-only \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 512 --memory 2g --cpus 1 \
    --ulimit core=0 \
    --log-driver "$MOMO_S3_LOG_DRIVER" \
    --tmpfs "/home/box:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001" \
    --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777" \
    --tmpfs "/opt/tools:rw,exec,nosuid,nodev,size=768m,mode=0755,uid=10001,gid=10001" \
    --tmpfs "/work:rw,noexec,nosuid,nodev,size=256m,mode=0755,uid=10001,gid=10001"
}

cmd_build() {
  runner_log "build $MOMO_S3_IMAGE"
  docker build -t "$MOMO_S3_IMAGE" "$MOMO_S3_HERE" >&2
}

cmd_up() {
  local persist=0
  [[ "${1:-}" == "--persist-login" ]] && persist=1
  local args=()
  while IFS= read -r l; do args+=("$l"); done < <(box_run_args "$persist")
  runner_log "up persist=$persist driver=$MOMO_S3_LOG_DRIVER"
  docker run -d --name "$MOMO_S3_NAME" "${args[@]}" "$MOMO_S3_IMAGE" sleep infinity >/dev/null
  echo "box up: $MOMO_S3_NAME (persist=$persist). Next: momo-s3-box.sh shell"
}

cmd_shell() {
  runner_log "shell"
  exec docker exec -it "$MOMO_S3_NAME" bash -l
}

cmd_down() {
  runner_log "down ${1:-}"
  docker rm -f "$MOMO_S3_NAME" >/dev/null 2>&1 || true
  if [[ "${1:-}" == "--purge" ]]; then docker volume rm -f "$MOMO_S3_CRED_VOLUME" >/dev/null 2>&1 || true; fi
}

# Feeds each host-side artifact INTO the box so secret values from /cred never leave it.
cmd_audit() {
  local rc=0 id
  scan() { # label, command producing stream
    local label="$1"; shift
    if ! { "$@" 2>&1 || true; } | docker exec -i "$MOMO_S3_NAME" momo-box-leakscan "$label"; then rc=1; fi
  }
  id="$(docker inspect -f '{{.Id}}' "$MOMO_S3_NAME")"
  scan docker-logs docker logs "$MOMO_S3_NAME"
  scan runner-log cat "$MOMO_S3_STATE_DIR/runner.log"
  if command -v colima >/dev/null 2>&1 && colima status >/dev/null 2>&1; then
    scan vm-container-dir colima ssh -- sudo sh -c "cat /var/lib/docker/containers/$id/config.v2.json /var/lib/docker/containers/$id/hostconfig.json; find /var/lib/docker/containers/$id -name '*.log' -exec cat {} +"
  fi
  docker exec "$MOMO_S3_NAME" sh -c 'echo "credential files (names/sizes only):"; find /cred -type f -exec ls -l {} + 2>/dev/null | awk "{print \$5, \$9}"'
  return "$rc"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    build) cmd_build ;;
    up) shift; cmd_up "${1:-}" ;;
    shell) cmd_shell ;;
    audit) cmd_audit ;;
    down) shift; cmd_down "${1:-}" ;;
    *) sed -n 2,9p "$0"; exit 2 ;;
  esac
fi
