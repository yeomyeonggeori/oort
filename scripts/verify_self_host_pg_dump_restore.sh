#!/usr/bin/env bash
# #1654 AC: dump a local compose postgres stack, restore into a NEW compose
# postgres stack, assert member + message rows survive.
#
# Uses unique COMPOSE_PROJECT_NAME / host ports (avoids 8088/8080/8000 and
# conductor 23340-band). Tears down with canonical compose `--project-name`
# (not scripts/self_host_env.sh --compose down — #1650 working_dir mismatch).
#
# Dump and restore go through the operator scripts, which share
# scripts/lib/pg_dump_custom.sh with verify_backup_restore_rehearsal.sh.
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/pg_dump_custom.sh
. "$SCRIPT_DIR/lib/pg_dump_custom.sh"

fail() { printf '[t4-pg-dump] FAIL: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

need docker
need python3

OUT_DIR="${SELF_HOST_PG_DUMP_OUT_DIR:-${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-t4-pg-dump}}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

RUN_RANDOM="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-8 || true)"
[ -n "$RUN_RANDOM" ] || RUN_RANDOM="$(date -u +%s)"
SRC_PROJECT="momo_t4s1654_${RUN_RANDOM}"
DST_PROJECT="momo_t4d1654_${RUN_RANDOM}"
SRC_ENV="$OUT_DIR/${SRC_PROJECT}.secrets.env"
DST_ENV="$OUT_DIR/${DST_PROJECT}.secrets.env"
DUMP_DIR="$OUT_DIR/dumps"
EVIDENCE="$OUT_DIR/evidence.md"
MARKER="t4-1654-marker-${RUN_RANDOM}"
SRC_UP=0
DST_UP=0

pick_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

port_free() {
  local port="$1"
  python3 - "$port" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
try:
    s.bind(("127.0.0.1", port))
except OSError:
    raise SystemExit(1)
s.close()
PY
}

# Stay off well-known self-host / conductor / V-1 bands.
reserve_port() {
  local candidate="$1"
  local n=0
  while [ "$n" -lt 40 ]; do
    case "$candidate" in
      8080 | 8088 | 8000) candidate=$((candidate + 1)); n=$((n + 1)); continue ;;
    esac
    if [ "$candidate" -ge 23340 ] && [ "$candidate" -le 23349 ]; then
      candidate=24380
      n=$((n + 1))
      continue
    fi
    if [ "$candidate" -ge 24180 ] && [ "$candidate" -le 24189 ]; then
      candidate=24380
      n=$((n + 1))
      continue
    fi
    if port_free "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    n=$((n + 1))
  done
  pick_port
}

compose_cmd() {
  local project="$1" env_file="$2"
  shift 2
  docker compose --project-directory "$REPO_ROOT" --project-name "$project" \
    --env-file "$env_file" -f infra/rust/docker-compose.rust.yml "$@"
}

write_env() {
  local dest="$1" project="$2" web="$3" api="$4" cent="$5"
  [ -f infra/rust/rust-smoke.env.example ] || fail "missing infra/rust/rust-smoke.env.example"
  python3 - "$dest" "$project" "$web" "$api" "$cent" infra/rust/rust-smoke.env.example <<'PY'
import pathlib, sys
dest, project, web, api, cent, src = sys.argv[1:]
text = pathlib.Path(src).read_text(encoding="utf-8")
replacements = {
    "COMPOSE_PROJECT_NAME": project,
    "MOMO_RUST_API_PORT": api,
    "CENT_HOST_PORT": cent,
}
out = []
seen = set()
for line in text.splitlines():
    if not line or line.startswith("#") or "=" not in line:
        out.append(line)
        continue
    key = line.split("=", 1)[0]
    if key in replacements:
        out.append(f"{key}={replacements[key]}")
        seen.add(key)
        continue
    if key == "MOMO_CENTRIFUGO_WS_URL":
        out.append(f"MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:{cent}/connection/websocket")
        seen.add(key)
        continue
    out.append(line)
for key, value in replacements.items():
    if key not in seen:
        out.append(f"{key}={value}")
out.append(f"MOMO_WEB_PORT={web}")
out.append(f"DB_VOLUME_NAME={project}-pgdata")
pathlib.Path(dest).write_text("\n".join(out) + "\n", encoding="utf-8")
PY
  chmod 600 "$dest"
}

wait_pg() {
  local container="$1" user="$2" db="$3"
  local attempt=0
  until docker exec "$container" pg_isready -U "$user" -d "$db" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      docker logs "$container" >&2 || true
      fail "postgres did not become ready: $container"
    fi
    sleep 1
  done
}

psql_q() {
  local container="$1"
  shift
  docker exec -i "$container" psql -U momo -d momo -v ON_ERROR_STOP=1 -q "$@"
}

fingerprint() {
  local container="$1"
  psql_q "$container" -At <<SQL
SELECT
  (SELECT count(*)::text FROM member) || '|' ||
  (SELECT coalesce(string_agg(handle, ',' ORDER BY handle), '') FROM member) || '|' ||
  (SELECT count(*)::text FROM message) || '|' ||
  (SELECT coalesce(md5(string_agg(seq::text || ':' || coalesce(body, ''), ',' ORDER BY seq)), '') FROM message);
SQL
}

cleanup() {
  if [ "$SRC_UP" = "1" ]; then
    compose_cmd "$SRC_PROJECT" "$SRC_ENV" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "$DST_UP" = "1" ]; then
    compose_cmd "$DST_PROJECT" "$DST_ENV" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm -f "${SRC_PROJECT}-probe" "${DST_PROJECT}-probe" >/dev/null 2>&1 || true
}
trap cleanup EXIT

SRC_WEB="$(reserve_port 24380)"
SRC_API="$(reserve_port $((SRC_WEB + 1)))"
SRC_CENT="$(reserve_port $((SRC_API + 1)))"
DST_WEB="$(reserve_port $((SRC_CENT + 1)))"
DST_API="$(reserve_port $((DST_WEB + 1)))"
DST_CENT="$(reserve_port $((DST_API + 1)))"

write_env "$SRC_ENV" "$SRC_PROJECT" "$SRC_WEB" "$SRC_API" "$SRC_CENT"
write_env "$DST_ENV" "$DST_PROJECT" "$DST_WEB" "$DST_API" "$DST_CENT"

printf '[t4-pg-dump] src project=%s ports web=%s api=%s cent=%s\n' \
  "$SRC_PROJECT" "$SRC_WEB" "$SRC_API" "$SRC_CENT"
printf '[t4-pg-dump] dst project=%s ports web=%s api=%s cent=%s\n' \
  "$DST_PROJECT" "$DST_WEB" "$DST_API" "$DST_CENT"

compose_cmd "$SRC_PROJECT" "$SRC_ENV" up -d --wait postgres
SRC_UP=1
SRC_CONTAINER="$(
  MOMO_PG_COMPOSE_PROJECT="$SRC_PROJECT" momo_pg_resolve_postgres_container
)" || fail "src postgres container missing"
wait_pg "$SRC_CONTAINER" momo momo

docker exec -i "$SRC_CONTAINER" psql -U momo -d momo -v ON_ERROR_STOP=1 -q <"$REPO_ROOT/schema_v0.sql" >/dev/null

psql_q "$SRC_CONTAINER" >/dev/null <<SQL
INSERT INTO workspace (slug, name) VALUES ('t4-recovery', 'T-4 recovery');
INSERT INTO member (workspace_id, kind, status, display_name, handle)
SELECT id, 'human', 'active', 't4-operator', 't4op' FROM workspace WHERE slug = 't4-recovery';
INSERT INTO member (workspace_id, kind, status, display_name, handle)
SELECT id, 'agent', 'active', 't4-agent', 't4agent' FROM workspace WHERE slug = 't4-recovery';
INSERT INTO channel (workspace_id, kind, name)
SELECT id, 'public', 'general' FROM workspace WHERE slug = 't4-recovery';
INSERT INTO message (
  workspace_id, channel_id, seq, hlc_ts, hlc_count,
  author_member_id, type, state, body, client_msg_id
)
SELECT
  w.id, c.id, 1, (extract(epoch from now()) * 1000)::bigint, 0,
  m.id, 'text', 'sent', '${MARKER}', uuidv7()
FROM workspace w
JOIN channel c ON c.workspace_id = w.id AND c.name = 'general'
JOIN member m ON m.workspace_id = w.id AND m.handle = 't4op'
WHERE w.slug = 't4-recovery';
SQL

SRC_FP="$(fingerprint "$SRC_CONTAINER")"
SRC_BODY="$(psql_q "$SRC_CONTAINER" -Atc "SELECT body FROM message ORDER BY seq LIMIT 1;")"
echo "$SRC_FP" | grep -q '|t4agent,t4op|' || fail "source member fingerprint unexpected: $SRC_FP"
[ "$SRC_BODY" = "$MARKER" ] || fail "source message marker missing: $SRC_BODY"

mkdir -p "$DUMP_DIR"
DUMP_OUT="$(
  "$SCRIPT_DIR/self_host_pg_dump.sh" \
    --compose-project "$SRC_PROJECT" \
    --env-file "$SRC_ENV" \
    --output-dir "$DUMP_DIR"
)"
printf '%s\n' "$DUMP_OUT"
echo "$DUMP_OUT" | grep -Eqi 'password|postgres://|change-me-' && fail "dump stdout leaked a credential"
DUMP_FILE="$(printf '%s\n' "$DUMP_OUT" | awk -F': ' '$1 == "[self-host-backup] path" { print $2; exit }')"
[ -s "$DUMP_FILE" ] || fail "operator dump did not produce a file"

compose_cmd "$DST_PROJECT" "$DST_ENV" up -d --wait postgres
DST_UP=1
DST_CONTAINER="$(
  MOMO_PG_COMPOSE_PROJECT="$DST_PROJECT" momo_pg_resolve_postgres_container
)" || fail "dst postgres container missing"
wait_pg "$DST_CONTAINER" momo momo

RESTORE_OUT="$(
  "$SCRIPT_DIR/self_host_pg_restore.sh" \
    --compose-project "$DST_PROJECT" \
    --env-file "$DST_ENV" \
    --dump "$DUMP_FILE"
)"
printf '%s\n' "$RESTORE_OUT"
echo "$RESTORE_OUT" | grep -Eqi 'password|postgres://|change-me-' && fail "restore stdout leaked a credential"

DST_FP="$(fingerprint "$DST_CONTAINER")"
[ "$SRC_FP" = "$DST_FP" ] || fail "restore fingerprint mismatch src=$SRC_FP dst=$DST_FP"

MEMBER_COUNT="$(psql_q "$DST_CONTAINER" -Atc "SELECT count(*) FROM member;")"
MESSAGE_COUNT="$(psql_q "$DST_CONTAINER" -Atc "SELECT count(*) FROM message;")"
MESSAGE_BODY="$(psql_q "$DST_CONTAINER" -Atc "SELECT body FROM message ORDER BY seq LIMIT 1;")"
[ "$MEMBER_COUNT" = "2" ] || fail "dest member count=$MEMBER_COUNT"
[ "$MESSAGE_COUNT" = "1" ] || fail "dest message count=$MESSAGE_COUNT"
[ "$MESSAGE_BODY" = "$MARKER" ] || fail "dest message body mismatch"

compose_cmd "$SRC_PROJECT" "$SRC_ENV" down -v --remove-orphans >/dev/null
SRC_UP=0
compose_cmd "$DST_PROJECT" "$DST_ENV" down -v --remove-orphans >/dev/null
DST_UP=0

src_left="$(docker ps -aq --filter "label=com.docker.compose.project=${SRC_PROJECT}" | awk 'NF' | wc -l | tr -d '[:space:]')"
dst_left="$(docker ps -aq --filter "label=com.docker.compose.project=${DST_PROJECT}" | awk 'NF' | wc -l | tr -d '[:space:]')"
src_vol="$(docker volume ls -q --filter "name=${SRC_PROJECT}" | awk 'NF' | wc -l | tr -d '[:space:]')"
dst_vol="$(docker volume ls -q --filter "name=${DST_PROJECT}" | awk 'NF' | wc -l | tr -d '[:space:]')"
[ "$src_left" = "0" ] && [ "$dst_left" = "0" ] || fail "compose containers remain src=$src_left dst=$dst_left"
[ "$src_vol" = "0" ] && [ "$dst_vol" = "0" ] || fail "compose volumes remain src=$src_vol dst=$dst_vol"

{
  echo "## T-4 self-host pg_dump restore evidence"
  echo "- Result: \`PASS\`"
  echo "- Goal: #1654"
  echo "- Source project: \`$SRC_PROJECT\`"
  echo "- Dest project: \`$DST_PROJECT\`"
  echo "- Source ports: web=$SRC_WEB api=$SRC_API cent=$SRC_CENT"
  echo "- Dest ports: web=$DST_WEB api=$DST_API cent=$DST_CENT"
  echo "- Fingerprint: \`$SRC_FP\`"
  echo "- Members restored: \`$MEMBER_COUNT\`"
  echo "- Messages restored: \`$MESSAGE_COUNT\`"
  echo "- Marker present: yes"
  echo "- Dump bytes: \`$(wc -c <"$DUMP_FILE" | tr -d '[:space:]')\`"
  echo "- Credentials in stdout: none"
  echo
} >"$EVIDENCE"

printf '[t4-pg-dump] PASS members=%s messages=%s\n' "$MEMBER_COUNT" "$MESSAGE_COUNT"
printf '[t4-pg-dump] evidence: %s\n' "$EVIDENCE"
