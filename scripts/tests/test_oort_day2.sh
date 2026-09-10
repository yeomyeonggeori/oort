#!/usr/bin/env bash
# Isolated red proofs for SH-3b / #2103 (scripts/oort day-2).
#
# Fixture-driven. Materialized env files live in a temp dir. The committed
# doctor template has no live secrets. Green on a stub is not evidence.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
OORT="$REPO_ROOT/scripts/oort"
TEMPLATE="$SCRIPT_DIR/fixtures/oort-doctor/valid.env.template"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-day2-test.XXXXXX")"
PG_CID=""
HTTP_PID=""
cleanup() {
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" >/dev/null 2>&1 || true
  [ -n "$PG_CID" ] && docker rm -f "$PG_CID" >/dev/null 2>&1 || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[oort-day2-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[oort-day2-test] ok: $*"; }

[ -x "$OORT" ] || chmod +x "$OORT"
[ -f "$TEMPLATE" ] || fail "missing fixture template: $TEMPLATE"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"

bash -n "$OORT" || fail "bash -n scripts/oort"
for f in "$REPO_ROOT"/scripts/lib/oort_*.sh; do
  [ -f "$f" ] || continue
  bash -n "$f" || fail "bash -n $f"
done
bash -n "$SCRIPT_DIR/test_oort_day2.sh" || fail "bash -n test_oort_day2.sh"
pass "bash -n on dispatcher, day-2 libs, and this harness"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x "$OORT" || fail "shellcheck scripts/oort"
  for f in "$REPO_ROOT"/scripts/lib/oort_*.sh; do
    [ -f "$f" ] || continue
    shellcheck -x "$f" || fail "shellcheck $f"
  done
  shellcheck -x "$SCRIPT_DIR/test_oort_day2.sh" || fail "shellcheck test_oort_day2.sh"
  pass "shellcheck clean"
else
  echo "[oort-day2-test] shellcheck not installed — skipped"
fi

port_busy() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; }
  return 1
}

pick_port() {
  local port="$1" limit=$(($1 + 40))
  [ "$limit" -le 65536 ] || limit=65536
  while [ "$port" -lt "$limit" ]; do
    port_busy "$port" || { printf '%s' "$port"; return 0; }
    port=$((port + 1))
  done
  fail "no free port near $1"
}

TOKEN_PG="$(openssl rand -hex 12)"
TOKEN_APP="$(openssl rand -hex 12)"
TOKEN_RELAY="$(openssl rand -hex 12)"
TOKEN_WORKER="$(openssl rand -hex 12)"
TOKEN_JWT="$(openssl rand -hex 12)"
TOKEN_CENT_TOKEN="$(openssl rand -hex 12)"
TOKEN_CENT_API="$(openssl rand -hex 12)"
TOKEN_CENT_PROXY="$(openssl rand -hex 12)"
TOKEN_PLINK="$(openssl rand -hex 12)"
TOKEN_OWNER="$(openssl rand -hex 12)"
WEB_PORT="$(pick_port 18088)"
API_PORT="$(pick_port 18080)"
CENT_PORT="$(pick_port 18000)"

LIST_DIGEST="$(jq -r '.images.app.digest_list' "$REPO_ROOT/releases/latest.json")"
ARCH_DIGEST="$(jq -r '.images.app.digests.amd64' "$REPO_ROOT/releases/latest.json")"
printf '%s' "$LIST_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "latest.json digest_list"
printf '%s' "$ARCH_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "latest.json amd64 digest"
[ "$LIST_DIGEST" != "$ARCH_DIGEST" ] || fail "list digest unexpectedly equals arch digest"

materialize() {
  local dest="$1"
  python3 - "$TEMPLATE" "$dest" <<PY
import sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
repl = {
    "__TOKEN_PG__": "${TOKEN_PG}",
    "__TOKEN_APP__": "${TOKEN_APP}",
    "__TOKEN_RELAY__": "${TOKEN_RELAY}",
    "__TOKEN_WORKER__": "${TOKEN_WORKER}",
    "__TOKEN_JWT__": "${TOKEN_JWT}",
    "__TOKEN_CENT_TOKEN__": "${TOKEN_CENT_TOKEN}",
    "__TOKEN_CENT_API__": "${TOKEN_CENT_API}",
    "__TOKEN_CENT_PROXY__": "${TOKEN_CENT_PROXY}",
    "__TOKEN_PLINK__": "${TOKEN_PLINK}",
    "__TOKEN_OWNER__": "${TOKEN_OWNER}",
    "__TOKEN_WEB_PORT__": "${WEB_PORT}",
    "__TOKEN_API_PORT__": "${API_PORT}",
    "__TOKEN_CENT_PORT__": "${CENT_PORT}",
}
for k, v in repl.items():
    text = text.replace(k, v)
open(dest, "w", encoding="utf-8").write(text)
PY
  chmod 600 "$dest"
}

assert_no_secret_leak() {
  local label="$1"
  shift
  local token file
  for file in "$@"; do
    [ -f "$file" ] || continue
    for token in \
      "$TOKEN_PG" "$TOKEN_APP" "$TOKEN_RELAY" "$TOKEN_WORKER" \
      "$TOKEN_JWT" "$TOKEN_CENT_TOKEN" "$TOKEN_CENT_API" "$TOKEN_CENT_PROXY" \
      "$TOKEN_PLINK" "$TOKEN_OWNER"
    do
      if grep -F -- "$token" "$file" >/dev/null 2>&1; then
        fail "$label leaked secret token in $file"
      fi
    done
  done
}

run_cmd() {
  local stdout="$1" stderr="$2"
  shift 2
  set +e
  "$@" >"$stdout" 2>"$stderr"
  echo $?
  set -e
}

VALID="$SANDBOX/valid.env"
materialize "$VALID"

# --help lists --tier for backup/restore/upgrade/logs
for cmd in backup restore upgrade logs; do
  HELP_OUT="$SANDBOX/help-${cmd}.out"
  HELP_ERR="$SANDBOX/help-${cmd}.err"
  code="$(run_cmd "$HELP_OUT" "$HELP_ERR" "$OORT" "$cmd" --help)"
  [ "$code" = "0" ] || fail "$cmd --help exit $code stderr=$(cat "$HELP_ERR")"
  grep -Fq -- '--tier' "$HELP_OUT" "$HELP_ERR" || \
    fail "$cmd --help missing --tier: $(cat "$HELP_OUT") $(cat "$HELP_ERR")"
  pass "$cmd --help lists --tier"
done

# -----------------------------------------------------------------------------
# 1. status --json schema (doctor reuse + image object)
# -----------------------------------------------------------------------------
OUT="$SANDBOX/status.json"
ERR="$SANDBOX/status.err"
code="$(run_cmd "$OUT" "$ERR" "$OORT" status --env "$VALID" --json)"
[ "$code" = "0" ] || fail "status --json exit $code (want 0); stderr=$(cat "$ERR")"
jq -e '
  (.summary | type == "object")
  and (.summary.pass | type == "number")
  and (.summary.fail | type == "number")
  and (.summary.skip | type == "number")
  and (.summary.verdict == "PASS" or .summary.verdict == "FAIL")
  and (.image | type == "object")
  and (.image.current | type == "string")
  and (.image.manifest_list | type == "string")
  and (.image.state == "current" or .image.state == "behind"
       or .image.state == "local" or .image.state == "unknown")
  and (.checks | type == "array")
  and (
    .checks | all(
      (.id | type == "string" and length > 0)
      and (.severity == "blocker" or .severity == "major" or .severity == "minor")
      and (.status == "pass" or .status == "fail" or .status == "skip" or .status == "info")
      and (.detail | type == "string")
      and (.fix | type == "string")
    )
  )
' "$OUT" >/dev/null || fail "status --json schema: $(head -c 400 "$OUT")"
[ "$(jq -r '.image.state' "$OUT")" = "local" ] || \
  fail "fixture is local-build; image.state=$(jq -r '.image.state' "$OUT")"
assert_no_secret_leak "status json" "$OUT" "$ERR"
pass "status --json schema + local image state; no secret leak"

# -----------------------------------------------------------------------------
# 2. upgrade stops on missing env
# -----------------------------------------------------------------------------
OUT="$SANDBOX/upgrade-noenv.out"
ERR="$SANDBOX/upgrade-noenv.err"
code="$(run_cmd "$OUT" "$ERR" "$OORT" upgrade --env "$SANDBOX/missing.env" --yes --no-backup --to "$LIST_DIGEST")"
[ "$code" != "0" ] || fail "upgrade missing env exited 0"
grep -Eqi 'env|없다|missing|없음' "$ERR" "$OUT" || \
  fail "upgrade missing env did not mention env: stdout=$(cat "$OUT") stderr=$(cat "$ERR")"
grep -q 'SH-3b에서' "$ERR" "$OUT" && fail "upgrade missing env still a stub"
assert_no_secret_leak "upgrade missing env" "$OUT" "$ERR"
pass "upgrade missing env aborts"

# -----------------------------------------------------------------------------
# 3. upgrade stops on bad digest format
# -----------------------------------------------------------------------------
OUT="$SANDBOX/upgrade-baddigest.out"
ERR="$SANDBOX/upgrade-baddigest.err"
code="$(run_cmd "$OUT" "$ERR" "$OORT" upgrade --env "$VALID" --yes --no-backup --to not-a-digest)"
[ "$code" != "0" ] || fail "upgrade bad digest exited 0"
grep -Eqi 'sha256|digest|형식|format' "$ERR" "$OUT" || \
  fail "upgrade bad digest did not mention digest format: stderr=$(cat "$ERR")"
grep -q 'SH-3b에서' "$ERR" "$OUT" && fail "upgrade bad digest still a stub"
assert_no_secret_leak "upgrade bad digest" "$OUT" "$ERR"
pass "upgrade bad digest format aborts"

OUT="$SANDBOX/upgrade-arch.out"
ERR="$SANDBOX/upgrade-arch.err"
code="$(run_cmd "$OUT" "$ERR" "$OORT" upgrade --env "$VALID" --yes --no-backup --to "$ARCH_DIGEST")"
[ "$code" != "0" ] || fail "upgrade arch digest exited 0"
grep -Eqi 'list|arch|아키텍처|list≠arch|digest_list' "$ERR" "$OUT" || \
  fail "upgrade arch digest did not reject list≠arch: stderr=$(cat "$ERR")"
assert_no_secret_leak "upgrade arch digest" "$OUT" "$ERR"
pass "upgrade arch digest (list≠arch) aborts"

# -----------------------------------------------------------------------------
# 4. upgrade stops on missing volume and does not create it
# -----------------------------------------------------------------------------
ABSENT_VOL="oort-sh3b-absent-pg-$$"
ABSENT_DRIVE="oort-sh3b-absent-drive-$$"
MISSING_VOL_ENV="$SANDBOX/missing-vol.env"
awk -v db="$ABSENT_VOL" -v drive="$ABSENT_DRIVE" '
  index($0, "DB_VOLUME_NAME=") == 1 { print "DB_VOLUME_NAME=" db; next }
  index($0, "DRIVE_VOLUME_NAME=") == 1 { print "DRIVE_VOLUME_NAME=" drive; next }
  { print }
' "$VALID" >"$MISSING_VOL_ENV"
chmod 600 "$MISSING_VOL_ENV"
if docker volume inspect "$ABSENT_VOL" >/dev/null 2>&1; then
  fail "absent volume name already exists: $ABSENT_VOL"
fi
OUT="$SANDBOX/upgrade-novol.out"
ERR="$SANDBOX/upgrade-novol.err"
code="$(run_cmd "$OUT" "$ERR" "$OORT" upgrade --env "$MISSING_VOL_ENV" --yes --no-backup --to "$LIST_DIGEST")"
[ "$code" != "0" ] || fail "upgrade missing volume exited 0"
grep -Eqi 'volume|볼륨' "$ERR" "$OUT" || \
  fail "upgrade missing volume did not mention volume: stderr=$(cat "$ERR")"
if docker volume inspect "$ABSENT_VOL" >/dev/null 2>&1; then
  fail "upgrade created volume $ABSENT_VOL"
fi
if docker volume inspect "$ABSENT_DRIVE" >/dev/null 2>&1; then
  fail "upgrade created volume $ABSENT_DRIVE"
fi
assert_no_secret_leak "upgrade missing volume" "$OUT" "$ERR"
pass "upgrade missing volume aborts and does not create volumes"

# -----------------------------------------------------------------------------
# 5. restore refuses a non-empty stack (fake docker occupancy oracle)
# -----------------------------------------------------------------------------
FAKE_BIN="$SANDBOX/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/docker" <<'EOF'
#!/bin/sh
set -eu
log="${FAKE_DOCKER_LOG:-/tmp/fake-docker-day2.log}"
printf '%s\n' "$*" >>"$log"
# Occupancy is two queries: information_schema (exists) then count(*).
saw_schema=0
saw_count=0
for arg in "$@"; do
  case "$arg" in
    *information_schema*) saw_schema=1 ;;
  esac
  case "$arg" in
    *'FROM message'* | *'from message'*) saw_count=1 ;;
  esac
done
if [ "$saw_schema" -eq 1 ]; then
  printf '1\n'
  exit 0
fi
if [ "$saw_count" -eq 1 ]; then
  printf '4\n'
  exit 0
fi
if [ "${1:-}" = "compose" ]; then
  printf '4\n'
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 3
EOF
chmod +x "$FAKE_BIN/docker"
DUMP_FILE="$SANDBOX/sample.dump"
printf 'FAKE-PG-DUMP-CUSTOM-FORMAT' >"$DUMP_FILE"
OUT="$SANDBOX/restore-full.out"
ERR="$SANDBOX/restore-full.err"
FAKE_DOCKER_LOG="$SANDBOX/restore-docker.log"
: >"$FAKE_DOCKER_LOG"
set +e
PATH="$FAKE_BIN:$PATH" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
  "$OORT" restore "$DUMP_FILE" --env "$VALID" --yes \
  >"$OUT" 2>"$ERR"
rc=$?
set -e
[ "$rc" != "0" ] || fail "restore nonempty exited 0"
grep -Eqi 'empty|비어|거부|not empty|non-empty|비지' "$ERR" "$OUT" || \
  fail "restore nonempty did not refuse: stdout=$(cat "$OUT") stderr=$(cat "$ERR")"
if grep -Fq 'pg_restore' "$FAKE_DOCKER_LOG"; then
  fail "restore nonempty reached pg_restore"
fi
assert_no_secret_leak "restore nonempty" "$OUT" "$ERR"
pass "restore refuses a non-empty stack before pg_restore"

# -----------------------------------------------------------------------------
# 5b. restore into a roles-less empty dest: run runtime-roles or refuse,
#     before pg_restore (no second pg_restore call site).
# -----------------------------------------------------------------------------
cat >"$FAKE_BIN/docker" <<'EOF'
#!/bin/sh
set -eu
log="${FAKE_DOCKER_LOG:-/tmp/fake-docker-day2.log}"
printf '%s\n' "$*" >>"$log"
saw_schema=0
saw_roles=0
for arg in "$@"; do
  case "$arg" in
    *information_schema*) saw_schema=1 ;;
    *pg_roles*) saw_roles=1 ;;
  esac
done
if [ "$saw_schema" -eq 1 ]; then
  printf '0\n'
  exit 0
fi
if [ "$saw_roles" -eq 1 ]; then
  if grep -E '(^|[[:space:]])run[[:space:]]' "$log" | grep -Fq 'runtime-roles'; then
    printf '3\n'
    exit 0
  fi
  printf '0\n'
  exit 0
fi
if [ "${1:-}" = "compose" ]; then
  case " $* " in
    *" run "*" runtime-roles "*|*" runtime-roles "*" run "*) exit 0 ;;
  esac
  printf '0\n'
  exit 0
fi
if [ "${1:-}" = "ps" ]; then
  printf 'fake-pg-container\n'
  exit 0
fi
if [ "${1:-}" = "inspect" ]; then
  printf 'true\n'
  exit 0
fi
if [ "${1:-}" = "exec" ]; then
  exit 0
fi
if [ "${1:-}" = "info" ] || [ "${1:-}" = "--version" ]; then
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 3
EOF
chmod +x "$FAKE_BIN/docker"
OUT="$SANDBOX/restore-noroles.out"
ERR="$SANDBOX/restore-noroles.err"
FAKE_DOCKER_LOG="$SANDBOX/restore-noroles-docker.log"
: >"$FAKE_DOCKER_LOG"
set +e
PATH="$FAKE_BIN:$PATH" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
  "$OORT" restore "$DUMP_FILE" --env "$VALID" --yes \
  >"$OUT" 2>"$ERR"
rc=$?
set -e
# Must either refuse naming runtime-roles, or invoke that compose service
# before any pg_restore.
if grep -Fq 'pg_restore' "$FAKE_DOCKER_LOG"; then
  roles_line="$(grep -n 'runtime-roles' "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true)"
  restore_line="$(grep -n 'pg_restore' "$FAKE_DOCKER_LOG" | head -1 | cut -d: -f1 || true)"
  [ -n "$roles_line" ] || \
    fail "roles-less restore reached pg_restore without runtime-roles: $(cat "$FAKE_DOCKER_LOG")"
  [ "$roles_line" -lt "$restore_line" ] || \
    fail "runtime-roles must run before pg_restore (roles=$roles_line restore=$restore_line)"
else
  [ "$rc" != "0" ] || fail "roles-less restore exited 0 without pg_restore"
  grep -Eqi 'runtime-roles|MOMO_RUNTIME_ROLE_PROVISION|momo_app' "$ERR" "$OUT" || \
    fail "roles-less restore did not name runtime-roles: stdout=$(cat "$OUT") stderr=$(cat "$ERR")"
fi
assert_no_secret_leak "restore roles-less" "$OUT" "$ERR"
pass "restore into roles-less dest runs runtime-roles or refuses before pg_restore"

# -----------------------------------------------------------------------------
# 6. logs output: planted secrets → 0 hits
# -----------------------------------------------------------------------------
cat >"$FAKE_BIN/docker" <<EOF
#!/bin/sh
set -eu
log="\${FAKE_DOCKER_LOG:-/tmp/fake-docker-day2.log}"
printf '%s\\n' "\$*" >>"\$log"
echo "Authorization: Bearer planted-bearer-${TOKEN_JWT}"
echo "postgres://momo:${TOKEN_PG}@postgres:5432/momo"
echo "JWT_HMAC=${TOKEN_JWT}"
echo "POSTGRES_PASSWORD=${TOKEN_PG}"
echo "owner password was ${TOKEN_OWNER}"
echo "harmless log line about migrate IDEMPOTENCY_OK"
exit 0
EOF
chmod +x "$FAKE_BIN/docker"
OUT="$SANDBOX/logs.out"
ERR="$SANDBOX/logs.err"
FAKE_DOCKER_LOG="$SANDBOX/logs-docker.log"
: >"$FAKE_DOCKER_LOG"
set +e
PATH="$FAKE_BIN:$PATH" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" \
  "$OORT" logs api --env "$VALID" --since 10m \
  >"$OUT" 2>"$ERR"
rc=$?
set -e
[ "$rc" = "0" ] || fail "logs exit $rc; stderr=$(cat "$ERR")"
grep -q 'IDEMPOTENCY_OK' "$OUT" || fail "logs dropped a non-secret line"
assert_no_secret_leak "logs" "$OUT" "$ERR"
if grep -Fq "planted-bearer-${TOKEN_JWT}" "$OUT" "$ERR"; then
  fail "logs leaked planted bearer"
fi
grep -Fq '***' "$OUT" || fail "logs did not mask secrets with ***"
pass "logs masks planted secrets (0 hits) and keeps non-secret lines"

# -----------------------------------------------------------------------------
# 7. T2 URL backup/restore (local postgres:18 pretending to be railway)
# -----------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is required for T2 URL proofs"
docker info >/dev/null 2>&1 || fail "docker daemon is required for T2 URL proofs"
# shellcheck source=../lib/pg_dump_custom.sh
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/pg_dump_custom.sh"
PG_RESTORE_BIN="$(momo_pg_client_bin pg_restore)" || fail "pg_restore 없음 (postgresql-client 필요)"
PSQL_BIN="$(momo_pg_client_bin psql)" || fail "psql 없음 (postgresql-client 필요)"

PG_PORT="$(pick_port 25432)"
PG_CID="$(docker run -d --rm \
  -e POSTGRES_USER=momo \
  -e POSTGRES_PASSWORD="$TOKEN_PG" \
  -e POSTGRES_DB=momo \
  -p "127.0.0.1:${PG_PORT}:5432" \
  postgres:18)"
i=0
while [ "$i" -lt 40 ]; do
  if docker exec "$PG_CID" pg_isready -U momo >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
docker exec "$PG_CID" pg_isready -U momo >/dev/null 2>&1 || \
  fail "throwaway postgres:18 did not become ready"
T2_URL="postgres://momo:${TOKEN_PG}@127.0.0.1:${PG_PORT}/momo"

docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE message (id int);
CREATE TABLE outbox (
  kind text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lease_acquired_at timestamptz
);
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE ROLE momo_app;
CREATE ROLE momo_relay;
CREATE ROLE momo_worker;
SQL

T2_ENV="$SANDBOX/t2.env"
awk -v url="$T2_URL" '
  index($0, "MIGRATE_DATABASE_URL=") == 1 { print "MIGRATE_DATABASE_URL=" url; next }
  { print }
' "$VALID" >"$T2_ENV"
printf '\nMOMO_SELF_HOST_PLATFORM=railway\n' >>"$T2_ENV"
chmod 600 "$T2_ENV"

T2_OUT="$SANDBOX/t2-backup.out"
T2_ERR="$SANDBOX/t2-backup.err"
T2_DUMP_DIR="$SANDBOX/t2-dumps"
mkdir -p "$T2_DUMP_DIR"
code="$(run_cmd "$T2_OUT" "$T2_ERR" "$OORT" backup --tier t2 --env "$T2_ENV" --out "$T2_DUMP_DIR")"
[ "$code" = "0" ] || fail "T2 backup exit $code stdout=$(cat "$T2_OUT") stderr=$(cat "$T2_ERR")"
T2_DUMP="$(awk -F': ' '$1 == "[oort backup] path" { print $2; exit }' "$T2_OUT")"
[ -n "$T2_DUMP" ] && [ -s "$T2_DUMP" ] || fail "T2 backup produced no dump: $(cat "$T2_OUT")"
T2_BYTES="$(wc -c <"$T2_DUMP" | tr -d '[:space:]')"
[ "$T2_BYTES" -gt 0 ] || fail "T2 dump was 0 bytes"
assert_no_secret_leak "t2 backup" "$T2_OUT" "$T2_ERR"
if grep -Fq "$T2_URL" "$T2_OUT" "$T2_ERR"; then
  fail "T2 backup leaked MIGRATE_DATABASE_URL"
fi
pass "T2 backup --tier t2 dump bytes=${T2_BYTES} >0; no URL leak"

T1_DUMP="$SANDBOX/t1-container.dump"
momo_pg_dump_custom "$PG_CID" momo momo "$T1_DUMP"
toc_count() {
  "$PG_RESTORE_BIN" -l "$1" | awk '/^[0-9]+;/{ n++ } END { print n + 0 }'
}
T2_TOC="$(toc_count "$T2_DUMP")"
T1_TOC="$(toc_count "$T1_DUMP")"
[ "$T2_TOC" = "$T1_TOC" ] || \
  fail "T2 TOC ${T2_TOC} != T1 container dump TOC ${T1_TOC}"
[ "$T2_TOC" -gt 0 ] || fail "TOC item count was 0"
pass "T2 URL dump TOC items=${T2_TOC} match T1 container dump"

MSG_BEFORE="$("$PSQL_BIN" "$T2_URL" -At -c "SELECT count(*)::text FROM message;")"
T2_REST_OUT="$SANDBOX/t2-restore.out"
T2_REST_ERR="$SANDBOX/t2-restore.err"
code="$(run_cmd "$T2_REST_OUT" "$T2_REST_ERR" "$OORT" restore "$T2_DUMP" --tier t2 --env "$T2_ENV" --yes)"
[ "$code" = "0" ] || fail "T2 restore exit $code stdout=$(cat "$T2_REST_OUT") stderr=$(cat "$T2_REST_ERR")"
MSG_AFTER="$("$PSQL_BIN" "$T2_URL" -At -c "SELECT count(*)::text FROM message;")"
[ "$MSG_BEFORE" = "$MSG_AFTER" ] || \
  fail "T2 restore message count ${MSG_AFTER} != ${MSG_BEFORE}"
assert_no_secret_leak "t2 restore" "$T2_REST_OUT" "$T2_REST_ERR"
if grep -Fq "$T2_URL" "$T2_REST_OUT" "$T2_REST_ERR"; then
  fail "T2 restore leaked MIGRATE_DATABASE_URL"
fi
if grep -Fq 'compose up -d --wait' "$T2_REST_OUT" "$T2_REST_ERR"; then
  fail "T2 restore printed compose up -d --wait: $(cat "$T2_REST_OUT") $(cat "$T2_REST_ERR")"
fi
grep -Fq 'T2 — compose/volume 를 쓰지 않는다. 플랫폼 digest 교체.' "$T2_REST_OUT" "$T2_REST_ERR" || \
  fail "T2 restore missing platform redeploy wording: $(cat "$T2_REST_OUT") $(cat "$T2_REST_ERR")"
grep -Fq 'scripts/oort doctor --tier t2 --json' "$T2_REST_OUT" "$T2_REST_ERR" || \
  fail "T2 restore did not name doctor --tier t2 PASS: $(cat "$T2_REST_OUT") $(cat "$T2_REST_ERR")"
pass "T2 restore into empty stack keeps message count=${MSG_AFTER}"

docker exec -i "$PG_CID" psql -U momo -d momo -v ON_ERROR_STOP=1 <<'SQL'
DROP ROLE IF EXISTS momo_app;
DROP ROLE IF EXISTS momo_relay;
DROP ROLE IF EXISTS momo_worker;
SQL
T2_NOROLE_OUT="$SANDBOX/t2-norole.out"
T2_NOROLE_ERR="$SANDBOX/t2-norole.err"
code="$(run_cmd "$T2_NOROLE_OUT" "$T2_NOROLE_ERR" "$OORT" restore "$T2_DUMP" --tier t2 --env "$T2_ENV" --yes)"
[ "$code" != "0" ] || fail "T2 roles-less restore exited 0"
if ! grep -F '플랫폼 preDeploy(' "$T2_NOROLE_ERR" "$T2_NOROLE_OUT" | grep -Fq 'MOMO_RUNTIME_ROLE_PROVISION=1 momo-migrate'; then
  fail "T2 roles-less die phrase mismatch: stdout=$(cat "$T2_NOROLE_OUT") stderr=$(cat "$T2_NOROLE_ERR")"
fi
if ! grep -Fq '를 먼저 돌려라' "$T2_NOROLE_ERR" "$T2_NOROLE_OUT"; then
  fail "T2 roles-less die phrase missing 먼저 돌려라: stdout=$(cat "$T2_NOROLE_OUT") stderr=$(cat "$T2_NOROLE_ERR")"
fi
assert_no_secret_leak "t2 norole" "$T2_NOROLE_OUT" "$T2_NOROLE_ERR"
pass "T2 roles-less restore stops with preDeploy phrase"

# ③ Conflicting stamp (T1) + --tier t2 dies. No stamp + --tier t2 is accepted.
T1_STAMP="$SANDBOX/t1-stamped.env"
cp "$VALID" "$T1_STAMP"
printf '\nMOMO_SELF_HOST_PLATFORM=gcp-vm\n' >>"$T1_STAMP"
chmod 600 "$T1_STAMP"
MIS_OUT="$SANDBOX/tier-mismatch.out"
MIS_ERR="$SANDBOX/tier-mismatch.err"
code="$(run_cmd "$MIS_OUT" "$MIS_ERR" "$OORT" backup --tier t2 --env "$T1_STAMP" --out "$T2_DUMP_DIR")"
[ "$code" != "0" ] || fail "stamped T1 --tier t2 backup exited 0"
grep -Fq 'T1 스택을 URL 로 백업하지 않는다.' "$MIS_ERR" "$MIS_OUT" || \
  fail "tier mismatch did not explain the refusal: $(cat "$MIS_ERR") $(cat "$MIS_OUT")"
assert_no_secret_leak "tier mismatch" "$MIS_OUT" "$MIS_ERR"
pass "conflicting stamp + --tier t2 refuses (does not URL-backup T1)"

LOGS_MIS_OUT="$SANDBOX/logs-tier-mismatch.out"
LOGS_MIS_ERR="$SANDBOX/logs-tier-mismatch.err"
code="$(run_cmd "$LOGS_MIS_OUT" "$LOGS_MIS_ERR" "$OORT" logs --tier t2 --env "$T1_STAMP")"
[ "$code" != "0" ] || fail "logs --tier t2 on stamped T1 exited 0"
grep -Fq 'T1 스택을 URL 로 백업하지 않는다.' "$LOGS_MIS_ERR" "$LOGS_MIS_OUT" || \
  fail "logs --tier t2 mismatch sentence: $(cat "$LOGS_MIS_ERR") $(cat "$LOGS_MIS_OUT")"
assert_no_secret_leak "logs tier mismatch" "$LOGS_MIS_OUT" "$LOGS_MIS_ERR"
pass "logs --tier t2 on stamped T1 dies with the same mismatch sentence"

NOSTAMP="$SANDBOX/t2-nostamp.env"
grep -v '^MOMO_SELF_HOST_PLATFORM=' "$T2_ENV" >"$NOSTAMP"
chmod 600 "$NOSTAMP"
NOSTAMP_OUT="$SANDBOX/t2-nostamp.out"
NOSTAMP_ERR="$SANDBOX/t2-nostamp.err"
NOSTAMP_DIR="$SANDBOX/t2-nostamp-dumps"
mkdir -p "$NOSTAMP_DIR"
code="$(run_cmd "$NOSTAMP_OUT" "$NOSTAMP_ERR" "$OORT" backup --tier t2 --env "$NOSTAMP" --out "$NOSTAMP_DIR")"
[ "$code" = "0" ] || fail "no stamp + --tier t2 backup exit $code stdout=$(cat "$NOSTAMP_OUT") stderr=$(cat "$NOSTAMP_ERR")"
grep -Fq 'tier: t2 (explicit, env has no MOMO_SELF_HOST_PLATFORM)' "$NOSTAMP_ERR" "$NOSTAMP_OUT" || \
  fail "no-stamp --tier t2 missing note: $(cat "$NOSTAMP_ERR") $(cat "$NOSTAMP_OUT")"
NOSTAMP_DUMP="$(awk -F': ' '$1 == "[oort backup] path" { print $2; exit }' "$NOSTAMP_OUT")"
[ -n "$NOSTAMP_DUMP" ] && [ -s "$NOSTAMP_DUMP" ] || fail "no-stamp T2 backup produced no dump"
assert_no_secret_leak "no stamp tier t2" "$NOSTAMP_OUT" "$NOSTAMP_ERR"
pass "no stamp + --tier t2 accepted"

# Failed T2 backup must not leave a 0-byte dump.
SAB_ENV="$SANDBOX/t2-sabotage.env"
awk -v url="$T2_URL" '
  index($0, "MIGRATE_DATABASE_URL=") == 1 {
    sub(/:'"$TOKEN_PG"'@/, ":wrong-'"${TOKEN_PG}"'@")
    print
    next
  }
  { print }
' "$T2_ENV" >"$SAB_ENV"
chmod 600 "$SAB_ENV"
SAB_OUT="$SANDBOX/t2-sabotage.out"
SAB_ERR="$SANDBOX/t2-sabotage.err"
SAB_DIR="$SANDBOX/t2-sabotage-out"
mkdir -p "$SAB_DIR"
code="$(run_cmd "$SAB_OUT" "$SAB_ERR" "$OORT" backup --tier t2 --env "$SAB_ENV" --out "$SAB_DIR")"
[ "$code" != "0" ] || fail "sabotage-password backup exited 0"
SAB_DUMPS="$(find "$SAB_DIR" -type f -name '*.dump' 2>/dev/null | wc -l | tr -d '[:space:]')"
[ "$SAB_DUMPS" = "0" ] || fail "failed T2 backup left dump file(s) in --out: $(ls -la "$SAB_DIR")"
assert_no_secret_leak "t2 sabotage backup" "$SAB_OUT" "$SAB_ERR"
if grep -F -- "$TOKEN_PG" "$SAB_OUT" "$SAB_ERR" >/dev/null; then
  fail "sabotage backup leaked postgres password"
fi
pass "failed T2 backup leaves no dump in --out"

# T2 upgrade --no-backup prints digest replace and does not inspect volumes.
UP_OUT="$SANDBOX/t2-upgrade.out"
UP_ERR="$SANDBOX/t2-upgrade.err"
code="$(run_cmd "$UP_OUT" "$UP_ERR" "$OORT" upgrade --tier t2 --env "$T2_ENV" --yes --no-backup --to "$LIST_DIGEST")"
[ "$code" = "0" ] || fail "T2 upgrade --no-backup exit $code stdout=$(cat "$UP_OUT") stderr=$(cat "$UP_ERR")"
grep -Fq "$LIST_DIGEST" "$UP_OUT" "$UP_ERR" || \
  fail "T2 upgrade did not print the target list digest"
grep -Fq 'scripts/oort doctor --tier t2 --json' "$UP_OUT" "$UP_ERR" || \
  fail "T2 upgrade did not name doctor --tier t2 PASS as the done condition"
grep -Eqi '볼륨이 없다|oort_require_volumes|compose pull|compose build|compose up' "$UP_OUT" "$UP_ERR" && \
  fail "T2 upgrade invoked compose/volumes: $(cat "$UP_OUT") $(cat "$UP_ERR")"
assert_no_secret_leak "t2 upgrade" "$UP_OUT" "$UP_ERR"
pass "T2 upgrade --no-backup prints digest replace; no volume/compose"

echo "[oort-day2-test] PASS: $CASES case(s)"
