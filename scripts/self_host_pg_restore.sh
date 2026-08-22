#!/usr/bin/env bash
# Operator pg_restore for a new oort stack (#1654 / PLN T-4).
#
# Restores a custom-format dump produced by scripts/self_host_pg_dump.sh into
# the dest compose postgres service. Shares scripts/lib/pg_dump_custom.sh with
# the dump path and the rehearsal gate — do not add another pg_restore call site.
#
# Passwords and connection URLs are never printed.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/pg_dump_custom.sh
. "$SCRIPT_DIR/lib/pg_dump_custom.sh"

ENV_FILE="$REPO_ROOT/infra/rust/local.secrets.env"
DUMP_FILE=""
CONTAINER=""
COMPOSE_PROJECT=""
POSTGRES_USER_FLAG=""
POSTGRES_DB_FLAG=""
CLEAN=0

fail() { printf '[self-host-restore] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  scripts/self_host_pg_restore.sh --dump FILE
  scripts/self_host_pg_restore.sh --dump FILE --clean
  scripts/self_host_pg_restore.sh --dump FILE --env-file FILE
  scripts/self_host_pg_restore.sh --dump FILE --container NAME
  scripts/self_host_pg_restore.sh --dump FILE --compose-project NAME

Restores a pg_dump -Fc file into the dest compose postgres service.
Use --clean only when the dest database already has schema (full stack
already migrated) and you intend to replace it with the dump.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump)
      [ "$#" -ge 2 ] || fail "--dump 뒤에 덤프 파일이 필요하다."
      DUMP_FILE="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || fail "--env-file 뒤에 파일이 필요하다."
      ENV_FILE="$2"
      shift 2
      ;;
    --container)
      [ "$#" -ge 2 ] || fail "--container 뒤에 컨테이너 이름이 필요하다."
      CONTAINER="$2"
      shift 2
      ;;
    --compose-project)
      [ "$#" -ge 2 ] || fail "--compose-project 뒤에 프로젝트 이름이 필요하다."
      COMPOSE_PROJECT="$2"
      shift 2
      ;;
    --postgres-user)
      [ "$#" -ge 2 ] || fail "--postgres-user 뒤에 역할 이름이 필요하다."
      POSTGRES_USER_FLAG="$2"
      shift 2
      ;;
    --postgres-db)
      [ "$#" -ge 2 ] || fail "--postgres-db 뒤에 DB 이름이 필요하다."
      POSTGRES_DB_FLAG="$2"
      shift 2
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "알 수 없는 인자: $1"
      ;;
  esac
done

[ -n "$DUMP_FILE" ] || fail "--dump 가 필요하다."
[ -s "$DUMP_FILE" ] || fail "덤프 파일이 없거나 비었다."
command -v docker >/dev/null 2>&1 || fail "docker 없음"

PG_USER="${POSTGRES_USER_FLAG:-}"
PG_DB="${POSTGRES_DB_FLAG:-}"
if [ -z "$PG_USER" ] && [ -f "$ENV_FILE" ]; then
  PG_USER="$(momo_pg_env_get "$ENV_FILE" POSTGRES_USER || true)"
fi
if [ -z "$PG_DB" ] && [ -f "$ENV_FILE" ]; then
  PG_DB="$(momo_pg_env_get "$ENV_FILE" POSTGRES_DB || true)"
fi
PG_USER="${PG_USER:-momo}"
PG_DB="${PG_DB:-momo}"

MOMO_PG_CONTAINER="$CONTAINER"
MOMO_PG_COMPOSE_PROJECT="$COMPOSE_PROJECT"
MOMO_PG_ENV_FILE="$ENV_FILE"
PG_CONTAINER="$(momo_pg_resolve_postgres_container)" || fail "실행 중인 postgres 컨테이너를 찾지 못했다."

if [ "$CLEAN" = "1" ]; then
  printf '[self-host-restore] --clean: dest 객체를 덤프 내용으로 교체한다.\n'
  momo_pg_restore_custom "$PG_CONTAINER" "$PG_USER" "$PG_DB" "$DUMP_FILE" --clean --if-exists
else
  momo_pg_restore_custom "$PG_CONTAINER" "$PG_USER" "$PG_DB" "$DUMP_FILE"
fi

printf '[self-host-restore] restore finished\n'
printf '[self-host-restore] dump: %s\n' "$DUMP_FILE"
printf '[self-host-restore] 이어서 나머지 서비스를 올린다: scripts/self_host_env.sh --compose up -d --wait\n'
