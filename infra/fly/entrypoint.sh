#!/usr/bin/env bash
# Fly.io T1 host entrypoint (SH-11b).
# Starts dockerd with data-root on the volume, ensures a repo checkout and
# env file on that volume, then brings up the public compose overlay.
# Machine restart must restore the stack from /data (docker volumes + env).
set -euo pipefail

DATA_MOUNT="/data"
DOCKER_DATA_ROOT="/data/docker"
REPO_DIR="/data/oort"
ENV_FILE="${REPO_DIR}/infra/rust/local.secrets.env"
OORT_GIT_URL="${OORT_GIT_URL:-https://github.com/yeomyeonggeori/oort.git}"
DOCKERD_PID=""
DOCKERD_LOG="/var/log/dockerd.log"

log() { printf '[oort-fly] %s\n' "$*"; }
die() { printf '[oort-fly] FAIL %s\n' "$*" >&2; exit 1; }

# T1 file set the generator `--compose` path uses (rust.yml + local.override.yml,
# which defines service `web` — oort_doctor stack.compose_ps) plus the public
# overlay (caddy.override.yml) so 80/443 ACME still terminates in-VM.
compose_stack() {
  docker compose --env-file "${ENV_FILE}" \
    -f infra/rust/docker-compose.rust.yml \
    -f infra/rust/local.override.yml \
    -f infra/rust/caddy.override.yml \
    "$@"
}

wait_docker() {
  local i=0
  while [ "$i" -lt 60 ]; do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

start_dockerd() {
  local driver="$1"
  if [ -n "${DOCKERD_PID}" ] && kill -0 "${DOCKERD_PID}" 2>/dev/null; then
    kill "${DOCKERD_PID}" 2>/dev/null || true
    wait "${DOCKERD_PID}" 2>/dev/null || true
    DOCKERD_PID=""
  fi
  log "starting dockerd storage-driver=${driver} data-root=${DOCKER_DATA_ROOT}"
  dockerd \
    --host=unix:///var/run/docker.sock \
    --pidfile=/var/run/docker.pid \
    --data-root="${DOCKER_DATA_ROOT}" \
    --storage-driver="${driver}" \
    --iptables=true \
    >>"${DOCKERD_LOG}" 2>&1 &
  DOCKERD_PID="$!"
  if wait_docker; then
    log "dockerd ready pid=${DOCKERD_PID} driver=${driver}"
    return 0
  fi
  log "dockerd did not become ready with driver=${driver}"
  if [ -f "${DOCKERD_LOG}" ]; then
    tail -n 40 "${DOCKERD_LOG}" >&2 || true
  fi
  return 1
}

shutdown() {
  log "signal: stopping compose and dockerd"
  if [ -f "${ENV_FILE}" ] && [ -d "${REPO_DIR}" ]; then
    (
      CDPATH='' cd -- "${REPO_DIR}" || exit 0
      compose_stack stop || true
    )
  fi
  if [ -n "${DOCKERD_PID}" ]; then
    kill "${DOCKERD_PID}" 2>/dev/null || true
    wait "${DOCKERD_PID}" 2>/dev/null || true
  fi
}

trap shutdown SIGTERM SIGINT

[ "$(id -u)" -eq 0 ] || die "must run as root (dockerd)"

mkdir -p "${DOCKER_DATA_ROOT}" "${REPO_DIR}" /var/run /var/log
chmod 700 "${DATA_MOUNT}" || true

# Best-effort forwarding / cgroup so bridge networking works in the VM.
if [ -w /proc/sys/net/ipv4/ip_forward ]; then
  echo 1 >/proc/sys/net/ipv4/ip_forward || true
fi
mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true

if ! start_dockerd overlay2; then
  if ! start_dockerd fuse-overlayfs; then
    start_dockerd vfs || die "dockerd failed (overlay2, fuse-overlayfs, vfs). This Machine is not T1; see infra/fly/README.md alternative."
  fi
fi

if [ ! -d "${REPO_DIR}/.git" ]; then
  log "cloning ${OORT_GIT_URL} -> ${REPO_DIR}"
  rm -rf "${REPO_DIR}"
  git clone --depth 1 "${OORT_GIT_URL}" "${REPO_DIR}"
fi
[ -f "${REPO_DIR}/releases/latest.json" ] || die "checkout missing releases/latest.json"
[ -f "${REPO_DIR}/scripts/self_host_env.sh" ] || die "checkout missing scripts/self_host_env.sh"

CDPATH='' cd -- "${REPO_DIR}"

if [ ! -f "${ENV_FILE}" ]; then
  app_name="${FLY_APP_NAME:-}"
  if [ -n "${OORT_PUBLIC_ORIGIN:-}" ]; then
    public_origin="${OORT_PUBLIC_ORIGIN}"
  elif [ -n "${app_name}" ]; then
    public_origin="https://${app_name}.fly.dev"
  else
    die "first boot needs OORT_PUBLIC_ORIGIN or FLY_APP_NAME to derive --public-origin"
  fi
  image_ref="$(jq -er '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)" \
    || die "could not read images.app from releases/latest.json"
  log "creating env on volume (platform fly, origin not printed)"
  scripts/self_host_env.sh \
    --platform fly \
    --published-image "${image_ref}" \
    --public-origin "${public_origin}"
  chmod 600 "${ENV_FILE}" || true
else
  log "reusing env on volume (secrets not regenerated)"
fi

[ -f "${ENV_FILE}" ] || die "env file missing: ${ENV_FILE}"

# rust.yml + local.override.yml (`web`) is the T1 `--compose` set doctor
# stack.compose_ps reads. caddy.override.yml is the public ACME edge (A).
log "compose up (T1 web + public overlay)"
compose_stack up -d

log "stack requested; waiting on dockerd pid=${DOCKERD_PID}"
wait "${DOCKERD_PID}" || true
