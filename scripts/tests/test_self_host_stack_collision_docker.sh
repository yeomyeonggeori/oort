#!/usr/bin/env bash
# Real-docker proof for #1613: live-stack collision fail-closed + oort-pgdata
# migration notice. Temporary project names and volumes only.
#
# Never touch this machine's live self-host volume `oort-pgdata` or the
# `momo-tracks/engine` checkout. Inspect of `oort-pgdata` is read-only.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
if ! command -v docker >/dev/null 2>&1; then
  echo "self-host stack collision docker proof: SKIP (no docker binary)" >&2
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "self-host stack collision docker proof: SKIP (docker daemon unavailable)" >&2
  exit 0
fi

PROTECTED_VOLUMES=' oort-pgdata momo-pgdata momo-rust-pgdata '
PROTECTED_PROJECTS=' oort momo-rust momo '

assert_unprotected() {
  local kind="$1" name="$2"
  case " $PROTECTED_VOLUMES $PROTECTED_PROJECTS " in
    *" $name "*)
      echo "refusing to operate on protected $kind: $name" >&2
      exit 2
      ;;
  esac
  case "$name" in
    oort1613t*) ;;
    *)
      echo "temp $kind must be oort1613t* (got $name)" >&2
      exit 2
      ;;
  esac
}

PREFIX="oort1613t$$"
tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
WORKDIR="$(mktemp -d "${tmp_root}/${PREFIX}.XXXXXX")"
WORKDIR="$(CDPATH='' cd -P -- "$WORKDIR" && pwd)"
A="$WORKDIR/checkout-a"
B="$WORKDIR/checkout-b"
DUMMY_A="$WORKDIR/dummy-a"
PROJ_A="${PREFIX}a"
PROJ_B="${PREFIX}b"
VOL_A="${PROJ_A}-pgdata"
VOL_SHARED="${PREFIX}shared-pgdata"
REAL_DOCKER="$(command -v docker)"
OORT_PGDATA_BEFORE=""

cleanup() {
  local status=$?
  local volume
  docker compose -p "$PROJ_A" --project-directory "$DUMMY_A" -f "$DUMMY_A/compose.yml" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -f "$A/compose.yml" ]; then
    docker compose -p "$PROJ_A" --project-directory "$A" -f "$A/compose.yml" \
      down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker compose -p "$PROJ_B" --project-directory "$B" -f "$DUMMY_A/compose.yml" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f "$VOL_A" "$VOL_SHARED" "${PROJ_B}-pgdata" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  if [ -n "$OORT_PGDATA_BEFORE" ]; then
    if ! docker volume inspect oort-pgdata --format '{{.Name}}' >/dev/null 2>&1; then
      echo "PROTECTED volume oort-pgdata vanished during #1613 docker proof" >&2
      exit 2
    fi
  fi
  for volume in "$VOL_A" "$VOL_SHARED" "${PROJ_B}-pgdata"; do
    if docker volume ls -q | grep -Fxq "$volume"; then
      echo "temp volume leaked: $volume" >&2
      exit 2
    fi
  done
  exit "$status"
}
trap cleanup EXIT INT TERM

assert_unprotected project "$PROJ_A"
assert_unprotected project "$PROJ_B"
assert_unprotected volume "$VOL_A"
assert_unprotected volume "$VOL_SHARED"

if docker volume inspect oort-pgdata --format '{{.Name}}' >/dev/null 2>&1; then
  OORT_PGDATA_BEFORE="oort-pgdata"
fi

install_checkout() {
  local dest="$1"
  mkdir -p "$dest/scripts" "$dest/infra/rust" "$dest/fake-bin"
  cp "$ROOT/scripts/self_host_env.sh" "$dest/scripts/self_host_env.sh"
  cp "$ROOT/infra/rust/docker-compose.rust.yml" "$dest/infra/rust/docker-compose.rust.yml"
  cp "$ROOT/infra/rust/docker-compose.rust.build.yml" "$dest/infra/rust/docker-compose.rust.build.yml"
  cp "$ROOT/infra/rust/local.override.yml" "$dest/infra/rust/local.override.yml"
  chmod +x "$dest/scripts/self_host_env.sh"
}

install_compose_shim() {
  local dest="$1"
  cat >"$dest/fake-bin/docker" <<EOF
#!/usr/bin/env sh
set -eu
# Safety belt: never rm or compose-up the live self-host volume/project.
for argument in "\$@"; do
  case "\$argument" in
    oort-pgdata|-poort|--project-name=oort)
      printf 'shim refused protected name: %s\n' "\$argument" >&2
      exit 2
      ;;
  esac
done
if [ "\${1:-}" = "volume" ] && [ "\${2:-}" = "rm" ]; then
  for argument in "\$@"; do
    if [ "\$argument" = "oort-pgdata" ]; then
      printf 'shim refused volume rm oort-pgdata\n' >&2
      exit 2
    fi
  done
fi
if [ "\${1:-}" = "compose" ]; then
  printf '%s\n' "\$*" >>"$dest/compose-calls.log"
  subcommand=""
  previous=""
  for argument in "\$@"; do
    if [ -z "\$subcommand" ] && [ "\$previous" != "--env-file" ] &&
       [ "\$previous" != "-f" ] && [ "\$argument" != "compose" ] &&
       [ "\$argument" != "--env-file" ] && [ "\$argument" != "-f" ] &&
       ! printf '%s' "\$argument" | grep -q '^-'; then
      subcommand="\$argument"
    fi
    previous="\$argument"
  done
  case "\$subcommand" in
    config|images|version|help|ls)
      exec "$REAL_DOCKER" "\$@"
      ;;
    *)
      exit 0
      ;;
  esac
fi
exec "$REAL_DOCKER" "\$@"
EOF
  chmod +x "$dest/fake-bin/docker"
}

write_dummy_compose() {
  local dest="$1" volume="$2"
  mkdir -p "$dest"
  cat >"$dest/compose.yml" <<EOF
services:
  probe:
    image: busybox:1.36
    command: ["sleep", "120"]
    volumes:
      - pgdata:/data
volumes:
  pgdata:
    name: ${volume}
EOF
}

install_checkout "$A"
install_checkout "$B"
install_compose_shim "$A"
install_compose_shim "$B"
write_dummy_compose "$DUMMY_A" "$VOL_A"
: >"$A/compose-calls.log"
: >"$B/compose-calls.log"

docker pull -q busybox:1.36 >/dev/null

generate_env() {
  local dest="$1" project="$2" web_port="$3"
  (
    cd "$dest"
    PATH="/usr/bin:/bin:$PATH" \
      COMPOSE_PROJECT_NAME="$project" \
      MOMO_WEB_PORT="$web_port" \
      MOMO_RUST_API_PORT="$((web_port + 1))" \
      CENT_HOST_PORT="$((web_port + 2))" \
      bash scripts/self_host_env.sh --local-build
  )
}

generate_env "$A" "$PROJ_A" 55110 >/dev/null
generate_env "$B" "$PROJ_A" 55120 >/dev/null
grep -Fxq "COMPOSE_PROJECT_NAME=$PROJ_A" "$A/infra/rust/local.secrets.env"
grep -Fxq "DB_VOLUME_NAME=$VOL_A" "$A/infra/rust/local.secrets.env"
grep -Fxq "COMPOSE_PROJECT_NAME=$PROJ_A" "$B/infra/rust/local.secrets.env"

docker compose -p "$PROJ_A" --project-directory "$DUMMY_A" -f "$DUMMY_A/compose.yml" up -d >/dev/null
dummy_wd="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
  "$(docker ps -aq --filter "label=com.docker.compose.project=${PROJ_A}" | head -n 1)")"
dummy_wd_canon="$(CDPATH='' cd -P -- "$dummy_wd" && pwd)"
dummy_a_canon="$(CDPATH='' cd -P -- "$DUMMY_A" && pwd)"
[ "$dummy_wd_canon" = "$dummy_a_canon" ] || {
  echo "dummy working_dir was $dummy_wd ($dummy_wd_canon), expected $DUMMY_A ($dummy_a_canon)" >&2
  exit 1
}

# Scenario 1: same project name, other checkout. --compose up must abort
# before the rust stack is invoked.
if (
  cd "$B"
  PATH="$B/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose up -d --wait
) >"$B/up-same-project.out" 2>&1; then
  echo "real docker: foreign same-project up unexpectedly succeeded" >&2
  cat "$B/up-same-project.out" >&2
  exit 1
fi
grep -Fq '다른 체크아웃의 살아있는 스택' "$B/up-same-project.out"
grep -Fq 'dummy-a' "$B/up-same-project.out"
grep -Fq "$PROJ_A" "$B/up-same-project.out"
if grep -q ' up ' "$B/compose-calls.log"; then
  echo "real docker: compose up ran after a collision abort" >&2
  cat "$B/compose-calls.log" >&2
  exit 1
fi

# Scenario 2: different project, shared volume.
docker compose -p "$PROJ_A" --project-directory "$DUMMY_A" -f "$DUMMY_A/compose.yml" \
  down -v --remove-orphans >/dev/null
write_dummy_compose "$DUMMY_A" "$VOL_SHARED"
docker compose -p "$PROJ_A" --project-directory "$DUMMY_A" -f "$DUMMY_A/compose.yml" up -d >/dev/null
awk -v volume="$VOL_SHARED" -v project="$PROJ_B" '
  /^COMPOSE_PROJECT_NAME=/ { print "COMPOSE_PROJECT_NAME=" project; next }
  /^DB_VOLUME_NAME=/ { print "DB_VOLUME_NAME=" volume; next }
  { print }
' "$B/infra/rust/local.secrets.env" >"$B/infra/rust/patched.env"
mv "$B/infra/rust/patched.env" "$B/infra/rust/local.secrets.env"
: >"$B/compose-calls.log"
if (
  cd "$B"
  PATH="$B/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose up -d --wait
) >"$B/up-shared-volume.out" 2>&1; then
  echo "real docker: shared-volume up unexpectedly succeeded" >&2
  cat "$B/up-shared-volume.out" >&2
  exit 1
fi
grep -Fq '다른 체크아웃의 살아있는 스택' "$B/up-shared-volume.out"
grep -Fq "$VOL_SHARED" "$B/up-shared-volume.out"
grep -Fq "project=$PROJ_A" "$B/up-shared-volume.out"
if grep -q ' up ' "$B/compose-calls.log"; then
  echo "real docker: compose up ran after a shared-volume abort" >&2
  exit 1
fi

# Same-checkout resume: dummy working_dir is this checkout, no warning.
docker compose -p "$PROJ_A" --project-directory "$DUMMY_A" -f "$DUMMY_A/compose.yml" \
  down -v --remove-orphans >/dev/null
write_dummy_compose "$A" "$VOL_A"
docker compose -p "$PROJ_A" --project-directory "$A" -f "$A/compose.yml" up -d >/dev/null
: >"$A/compose-calls.log"
(
  cd "$A"
  PATH="$A/fake-bin:/usr/bin:/bin" \
    bash scripts/self_host_env.sh --compose up -d --wait
) >"$A/up-owner.out" 2>&1
if grep -Fq '다른 체크아웃의 살아있는 스택' "$A/up-owner.out"; then
  echo "real docker: same-checkout resume aborted as a collision" >&2
  cat "$A/up-owner.out" >&2
  exit 1
fi
grep -q ' up ' "$A/compose-calls.log"

# Migration notice against the real historical name, read-only.
if [ -n "$OORT_PGDATA_BEFORE" ]; then
  isolate="$WORKDIR/checkout-isolate"
  install_checkout "$isolate"
  (
    cd "$isolate"
    COMPOSE_PROJECT_NAME="${PREFIX}iso" \
      MOMO_WEB_PORT=55130 MOMO_RUST_API_PORT=55131 CENT_HOST_PORT=55132 \
      bash scripts/self_host_env.sh --local-build
  ) >"$isolate/generate.out" 2>&1
  grep -Fq '기존 셀프호스트 볼륨 oort-pgdata 가 있다' "$isolate/generate.out"
  grep -Fxq "DB_VOLUME_NAME=${PREFIX}iso-pgdata" "$isolate/infra/rust/local.secrets.env"
  docker volume inspect oort-pgdata --format '{{.Name}}' >/dev/null
  adopt="$WORKDIR/checkout-adopt"
  install_checkout "$adopt"
  (
    cd "$adopt"
    # Keep the historical project name only in a throwaway env file. Do not up.
    COMPOSE_PROJECT_NAME=oort \
      MOMO_WEB_PORT=55140 MOMO_RUST_API_PORT=55141 CENT_HOST_PORT=55142 \
      bash scripts/self_host_env.sh --local-build
  ) >"$adopt/generate.out" 2>&1
  grep -Fq '기존 볼륨 oort-pgdata 를 이 프로젝트의 데이터로 채택한다' "$adopt/generate.out"
  grep -Fxq 'DB_VOLUME_NAME=oort-pgdata' "$adopt/infra/rust/local.secrets.env"
  docker volume inspect oort-pgdata --format '{{.Name}}' >/dev/null
fi

echo "self-host stack collision docker proof: PASS"
