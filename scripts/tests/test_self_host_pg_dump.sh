#!/usr/bin/env bash
# Daemon-free contract for scripts/self_host_pg_dump.sh / self_host_pg_restore.sh.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-self-host-pg-dump.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    sha256sum "$1" | awk '{ print $1 }'
  fi
}

make_fixture() {
  local name="$1"
  local fixture="$TMP_ROOT/$name"
  mkdir -p "$fixture/scripts/lib" "$fixture/infra/rust" "$fixture/fake-bin" "$fixture/workspace"
  cp "$ROOT/scripts/self_host_pg_dump.sh" "$fixture/scripts/self_host_pg_dump.sh"
  cp "$ROOT/scripts/self_host_pg_restore.sh" "$fixture/scripts/self_host_pg_restore.sh"
  cp "$ROOT/scripts/lib/pg_dump_custom.sh" "$fixture/scripts/lib/pg_dump_custom.sh"
  chmod +x "$fixture/scripts/self_host_pg_dump.sh" "$fixture/scripts/self_host_pg_restore.sh" \
    "$fixture/scripts/lib/pg_dump_custom.sh"

  cat >"$fixture/infra/rust/local.secrets.env" <<'EOF'
COMPOSE_PROJECT_NAME=oort-t4-fixture
POSTGRES_DB=momo
POSTGRES_USER=momo
POSTGRES_PASSWORD=super-secret-do-not-print
MOMO_INITIAL_OWNER_PASSWORD=also-secret
EOF
  chmod 600 "$fixture/infra/rust/local.secrets.env"

  cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env sh
set -eu
log="${FAKE_DOCKER_LOG:-/tmp/fake-docker.log}"
printf '%s\n' "$*" >>"$log"
if [ "${1:-}" = "inspect" ]; then
  printf 'true\n'
  exit 0
fi
if [ "${1:-}" = "ps" ]; then
  printf 'fake-pg-container\n'
  exit 0
fi
if [ "${1:-}" = "exec" ]; then
  # docker exec [-i] CONTAINER pg_dump|pg_restore ...
  shift
  if [ "${1:-}" = "-i" ]; then
    shift
  fi
  container="$1"
  shift
  if [ "${1:-}" = "pg_dump" ]; then
    printf 'FAKE-PG-DUMP-CUSTOM-FORMAT'
    exit 0
  fi
  if [ "${1:-}" = "pg_restore" ]; then
    cat >/dev/null
    exit 0
  fi
  echo "unexpected docker exec: $container $*" >&2
  exit 3
fi
echo "unexpected docker invocation: $*" >&2
exit 3
EOF
  chmod +x "$fixture/fake-bin/docker"
  printf '%s\n' "$fixture"
}

run_dump() {
  local fixture="$1"
  shift
  FAKE_DOCKER_LOG="$fixture/docker.log" \
    PATH="$fixture/fake-bin:$PATH" \
    MOMO_BACKUP_WORKSPACE="$fixture/workspace" \
    "$fixture/scripts/self_host_pg_dump.sh" "$@"
}

# 1. --help
"$ROOT/scripts/self_host_pg_dump.sh" --help >/dev/null
"$ROOT/scripts/self_host_pg_restore.sh" --help >/dev/null
pass "help exits 0"

# 2. default dest is \$MOMO_BACKUP_WORKSPACE/oort-backups
fixture="$(make_fixture default-workspace)"
out="$(run_dump "$fixture")"
echo "$out" | grep -Fq "$fixture/workspace/oort-backups/" || fail "default dest was not workspace backups: $out"
echo "$out" | grep -Eqi 'super-secret|also-secret|password=' && fail "dump stdout leaked a secret: $out"
dump_path="$(printf '%s\n' "$out" | awk -F': ' '$1 == "[self-host-backup] path" { print $2; exit }')"
[ -s "$dump_path" ] || fail "dump file missing"
[ "$(cat "$dump_path")" = "FAKE-PG-DUMP-CUSTOM-FORMAT" ] || fail "dump bytes were not the fake pg_dump stdout"
mode="$(stat -f '%Lp' "$dump_path" 2>/dev/null || stat -c '%a' "$dump_path")"
[ "$mode" = "600" ] || fail "dump mode=$mode want 600"
grep -Fq "pg_dump -U momo -d momo -Fc" "$fixture/docker.log" || fail "fake docker did not see pg_dump -Fc"
pass "workspace default dest + no secret leak + pg_dump -Fc"

# 3. --output-dir override
fixture="$(make_fixture output-dir)"
alt="$fixture/alt-backups"
out="$(run_dump "$fixture" --output-dir "$alt")"
echo "$out" | grep -Fq "$alt/" || fail "--output-dir ignored: $out"
pass "--output-dir override"

# 4. missing /workspace without --output-dir fails
fixture="$(make_fixture no-workspace)"
rmdir "$fixture/workspace"
if MOMO_BACKUP_WORKSPACE="$fixture/missing" PATH="$fixture/fake-bin:$PATH" \
  "$fixture/scripts/self_host_pg_dump.sh" >/dev/null 2>"$fixture/err"; then
  fail "dump succeeded without workspace or --output-dir"
fi
grep -Fq -- "--output-dir" "$fixture/err" || fail "error did not mention --output-dir"
pass "missing workspace fails closed"

# 5. restore consumes --dump and calls pg_restore --no-owner
fixture="$(make_fixture restore)"
dump_file="$fixture/sample.dump"
printf 'FAKE-PG-DUMP-CUSTOM-FORMAT' >"$dump_file"
FAKE_DOCKER_LOG="$fixture/docker.log" PATH="$fixture/fake-bin:$PATH" \
  "$fixture/scripts/self_host_pg_restore.sh" --dump "$dump_file" --compose-project oort-t4-fixture \
  >"$fixture/restore.out"
grep -Fq "pg_restore -U momo -d momo --no-owner" "$fixture/docker.log" || fail "restore did not call shared pg_restore"
grep -Eqi 'super-secret|also-secret|password=' "$fixture/restore.out" && fail "restore stdout leaked a secret"
pass "restore uses shared --no-owner pg_restore"

# 6. --clean forwards --clean --if-exists
fixture="$(make_fixture restore-clean)"
dump_file="$fixture/sample.dump"
printf 'FAKE-PG-DUMP-CUSTOM-FORMAT' >"$dump_file"
FAKE_DOCKER_LOG="$fixture/docker.log" PATH="$fixture/fake-bin:$PATH" \
  "$fixture/scripts/self_host_pg_restore.sh" --dump "$dump_file" --clean --container fake-pg-container \
  >/dev/null
grep -Fq -- "--clean --if-exists" "$fixture/docker.log" || fail "--clean was not forwarded"
pass "restore --clean forwards pg_restore flags"

# 7. lib is the only dump implementation (rehearsal sources it)
grep -Fq 'momo_pg_dump_custom' "$ROOT/scripts/verify_backup_restore_rehearsal.sh" ||
  fail "rehearsal.sh no longer sources shared dump helper"
leaked="$(grep -n 'pg_dump -U' \
  "$ROOT/scripts/self_host_pg_dump.sh" \
  "$ROOT/scripts/self_host_pg_restore.sh" \
  "$ROOT/scripts/verify_backup_restore_rehearsal.sh" \
  "$ROOT/scripts/verify_self_host_pg_dump_restore.sh" || true)"
[ -z "$leaked" ] || fail "pg_dump -U leaked outside scripts/lib/pg_dump_custom.sh: $leaked"
pass "shared lib is the unique pg_dump -U implementation"

grep -Fq 'momo_pg_dump_custom_url' "$ROOT/scripts/lib/pg_dump_custom.sh" || \
  fail "momo_pg_dump_custom_url missing from pg_dump_custom.sh"
grep -Fq 'momo_pg_restore_custom_url' "$ROOT/scripts/lib/pg_dump_custom.sh" || \
  fail "momo_pg_restore_custom_url missing from pg_dump_custom.sh"
pass "URL dump/restore helpers live only in pg_dump_custom.sh"

# 8. URL dump failure passes pg_dump's rc through (not a hardcoded 1).
fixture="$(make_fixture url-rc)"
printf '\nMIGRATE_DATABASE_URL=postgres://momo:super-secret-do-not-print@127.0.0.1:1/momo\n' \
  >>"$fixture/infra/rust/local.secrets.env"
cat >"$fixture/fake-bin/pg_dump" <<'EOF'
#!/usr/bin/env sh
echo "pg_dump: fake fail" >&2
exit 3
EOF
chmod +x "$fixture/fake-bin/pg_dump"
url_rc=0
set +e
run_dump "$fixture" --migrate-url --output-dir "$fixture/url-out" \
  >"$fixture/url-rc.out" 2>"$fixture/url-rc.err"
url_rc=$?
set -e
[ "$url_rc" = "3" ] || fail "URL dump failure rc=$url_rc want 3 (pg_dump rc); stderr=$(cat "$fixture/url-rc.err")"
leftover="$(find "$fixture/url-out" -type f -name '*.dump' 2>/dev/null | wc -l | tr -d '[:space:]')"
[ "$leftover" = "0" ] || fail "failed URL dump left dump file(s): $(ls -la "$fixture/url-out" 2>/dev/null || true)"
grep -Eqi 'super-secret|password=' "$fixture/url-rc.out" "$fixture/url-rc.err" && \
  fail "URL dump failure leaked a secret"
pass "URL dump failure passes pg_dump rc=3; no leftover dump"

echo "PASS: self-host pg_dump contract"
