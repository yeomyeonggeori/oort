#!/usr/bin/env bash
# Operator pg_dump for self-host / Grok Bot VM recovery (#1654 / PLN T-4).
#
# Runs next to a live oort compose stack: docker exec pg_dump -Fc, write the
# dump under /workspace (Grok Bot durable layer) or --output-dir, print
# download instructions. Passwords and connection URLs are never printed.
#
# Dump/restore bytes go through scripts/lib/pg_dump_custom.sh — do not add
# another pg_dump -Fc call site.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/pg_dump_custom.sh
. "$SCRIPT_DIR/lib/pg_dump_custom.sh"

ENV_FILE="$REPO_ROOT/infra/rust/local.secrets.env"
OUTPUT_DIR=""
CONTAINER=""
COMPOSE_PROJECT=""
POSTGRES_USER_FLAG=""
POSTGRES_DB_FLAG=""

fail() { printf '[self-host-backup] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  scripts/self_host_pg_dump.sh
  scripts/self_host_pg_dump.sh --output-dir DIR
  scripts/self_host_pg_dump.sh --env-file FILE
  scripts/self_host_pg_dump.sh --container NAME
  scripts/self_host_pg_dump.sh --compose-project NAME

Dumps the live compose postgres service with pg_dump -Fc.
Default destination is /workspace/oort-backups when that directory exists
(Grok Bot VM). Elsewhere pass --output-dir.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      [ "$#" -ge 2 ] || fail "--output-dir 뒤에 디렉터리가 필요하다."
      OUTPUT_DIR="$2"
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

command -v docker >/dev/null 2>&1 || fail "docker 없음"

resolve_output_dir() {
  local root
  if [ -n "$OUTPUT_DIR" ]; then
    printf '%s\n' "$OUTPUT_DIR"
    return 0
  fi
  root="${MOMO_BACKUP_WORKSPACE:-/workspace}"
  if [ -d "$root" ] && [ -w "$root" ]; then
    printf '%s/oort-backups\n' "$root"
    return 0
  fi
  fail "/workspace 가 없거나 쓸 수 없다. --output-dir 로 저장 위치를 지정하세요."
}

DEST_DIR="$(resolve_output_dir)"
mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR" 2>/dev/null || true

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

STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
DUMP_FILE="$DEST_DIR/oort-pg-$STAMP.dump"

momo_pg_dump_custom "$PG_CONTAINER" "$PG_USER" "$PG_DB" "$DUMP_FILE"
chmod 600 "$DUMP_FILE"

DUMP_BYTES="$(wc -c <"$DUMP_FILE" | tr -d '[:space:]')"
if command -v shasum >/dev/null 2>&1; then
  DUMP_SHA="$(shasum -a 256 "$DUMP_FILE" | awk '{ print $1 }')"
else
  DUMP_SHA="$(sha256sum "$DUMP_FILE" | awk '{ print $1 }')"
fi

printf '[self-host-backup] dump ready\n'
printf '[self-host-backup] path: %s\n' "$DUMP_FILE"
printf '[self-host-backup] bytes: %s\n' "$DUMP_BYTES"
printf '[self-host-backup] sha256: %s\n' "$DUMP_SHA"
printf '[self-host-backup] 이 파일을 사용자 기기로 내려받으세요. 그록봇 VM이면 워크스페이스 파일 목록에서 고릅니다.\n'
printf '[self-host-backup] 복원: docs/runbooks/selfhost-pg-dump-restore.md\n'
