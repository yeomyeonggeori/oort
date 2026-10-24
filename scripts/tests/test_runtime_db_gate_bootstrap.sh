#!/usr/bin/env bash
# #4386 regression: the runtime-db gate bootstrap. No Docker daemon, no DB, no
# network — `docker` is a recording stub on PATH.
#
# What each scenario pins (each was a distinct reason the profile could not pass on
# a clean machine):
#   A  gate_runtime_db.sh up   publishes PG on loopback only, with the SAME pinned
#                              image digest as the compose stack, and the env file
#                              it writes satisfies the real scripts/ensure_runtime_env.sh
#                              and carries a DATABASE_URL on the published port.
#   B  psql absent             fails in `up` before any container starts, with a hint.
#   C  gate_runtime_db.sh down removes only a container carrying this run's label.
#   D  local_gate.sh wiring    runtime-db brings the DB up before the env guard, no
#                              longer calls `make up`, and exports ENV_FILE after it.
#   E  verify_owner_bootstrap_rust.sh env covers every `${VAR:?}` the runtime-roles
#                              and migrate services demand (NOTIFIER_* was missing).
#   F  verify_t3_migration_repair.sh   no retired `swift` requirement; the server it
#                              boots gets JWT_HMAC and both webhook master keys.
#   G  verify_huddle_lifecycle.sh      accepts keg-only libpq (not on PATH).
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-runtime-db-gate-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT INT TERM
cd "$REPO_ROOT"

# Scripts under test may be swapped for sabotaged copies (see the PR table): the
# harness reads them from $UNDER_TEST_DIR, defaulting to the real tree.
SCRIPTS="${UNDER_TEST_DIR:-$REPO_ROOT/scripts}"

fail() { echo "[runtime-db-gate-test] FAIL: $*" >&2; exit 1; }
pass() { echo "[runtime-db-gate-test] PASS $*"; }

COMPOSE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
PINNED_IMAGE="$(sed -n 's/^    image: \(pgvector\/pgvector:[^ ]*\)$/\1/p' "$COMPOSE" | head -n 1)"
[ -n "$PINNED_IMAGE" ] || fail "could not read the pinned Postgres image from $COMPOSE"

# ---- docker stub ------------------------------------------------------------
BIN="$SANDBOX/bin"
mkdir -p "$BIN"
CALLS="$SANDBOX/docker.calls"
: >"$CALLS"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_STUB_CALLS"
case "$1" in
  info) exit 0 ;;
  run) exit 0 ;;
  port) echo "127.0.0.1:45432"; exit 0 ;;
  exec) [ -n "${DOCKER_STUB_EXEC_FAIL:-}" ] && exit 1; exit 0 ;;
  inspect)
    case "$*" in
      *State.Status*) echo running ;;
      *) printf '%s\n' "${DOCKER_STUB_LABEL:-}" ;;
    esac
    exit 0 ;;
  rm) exit 0 ;;
  compose) exit 0 ;;   # ensure_runtime_env.sh: `compose ps -q` -> no container
  *) exit 0 ;;
esac
STUB
chmod +x "$BIN/docker"
export DOCKER_STUB_CALLS="$CALLS"
printf '#!/bin/sh\nexit 0\n' >"$BIN/cargo"
chmod +x "$BIN/cargo"

# Fake libpq: a psql that exists but is not on PATH.
LIBPQ="$SANDBOX/libpq/bin"
mkdir -p "$LIBPQ"
printf '#!/bin/sh\nexit 0\n' >"$LIBPQ/psql"
chmod +x "$LIBPQ/psql"
EMPTY_LIBPQ="$SANDBOX/no-libpq"
mkdir -p "$EMPTY_LIBPQ"

# PATH with docker stub + python3/core tools but no psql.
BASE_PATH="$BIN:/usr/bin:/bin"
command -v python3 >/dev/null 2>&1 || fail "python3 required"
PY_DIR="$(dirname "$(command -v python3)")"
case ":$BASE_PATH:" in *":$PY_DIR:"*) ;; *) BASE_PATH="$BASE_PATH:$PY_DIR" ;; esac
if PATH="$BASE_PATH" command -v psql >/dev/null 2>&1; then
  # A system psql would mask scenario B; rebuild PATH from symlinks to what we need.
  SAFE="$SANDBOX/safe-bin"
  mkdir -p "$SAFE"
  for tool in bash sh env sed head tail awk grep cat date sleep mkdir rm chmod printf dirname tr sort uniq cut shasum python3 mktemp; do
    src="$(PATH="$BASE_PATH" command -v "$tool" 2>/dev/null || true)"
    [ -n "$src" ] && ln -sf "$src" "$SAFE/$tool"
  done
  ln -sf "$BIN/docker" "$SAFE/docker"
  ln -sf "$BIN/cargo" "$SAFE/cargo"
  BASE_PATH="$SAFE"
fi

OUT="$SANDBOX/out"
mkdir -p "$OUT"
export LOCAL_GATE_OUTPUT_DIR="$OUT" LOCAL_GATE_RUN_ID="test-run-4386"

# ---- A: up ------------------------------------------------------------------
: >"$CALLS"
up_log="$SANDBOX/up.log"
PATH="$BASE_PATH" MOMO_LIBPQ_BIN_DIRS="$LIBPQ" bash "$SCRIPTS/gate_runtime_db.sh" up >"$up_log" 2>&1 \
  || { cat "$up_log" >&2; fail "A: up exited non-zero"; }
run_line="$(grep '^run ' "$CALLS" | head -n 1)"
[ -n "$run_line" ] || fail "A: no docker run was issued"
case "$run_line" in *"-p 127.0.0.1::5432"*) ;; *) fail "A: PG must publish on loopback only (-p 127.0.0.1::5432); got: $run_line" ;; esac
case "$run_line" in *"$PINNED_IMAGE"*) ;; *) fail "A: image is not the compose-pinned digest ($PINNED_IMAGE)" ;; esac
case "$run_line" in *"com.momo.gate-runtime-db=test-run-4386"*) ;; *) fail "A: container is not labelled with the run id" ;; esac
ENVF="$OUT/runtime-db.env"
[ -f "$ENVF" ] || fail "A: env file not written"
mode="$(stat -f '%Lp' "$ENVF" 2>/dev/null || stat -c '%a' "$ENVF")"
[ "$mode" = "600" ] || fail "A: env file mode is $mode, expected 600"
grep -Eq '^DATABASE_URL=postgres://momo:[0-9a-f]{48}@127\.0\.0\.1:45432/momo$' "$ENVF" \
  || fail "A: DATABASE_URL does not point at the published port with a generated password"
grep -Eq '^POSTGRES_PORT=45432$' "$ENVF" || fail "A: POSTGRES_PORT is not the published port"
pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$ENVF")"
if grep -Fq "$pw" "$up_log" "$CALLS"; then fail "A: the generated password leaked into stdout or docker argv"; fi
ER_LOG="$SANDBOX/ensure.log"
PATH="$BASE_PATH" ENV_FILE="$ENVF" bash "$REPO_ROOT/scripts/ensure_runtime_env.sh" >"$ER_LOG" 2>&1 \
  || { cat "$ER_LOG" >&2; fail "A: the generated env does not satisfy scripts/ensure_runtime_env.sh"; }
pass "A up: loopback-only, pinned digest, labelled, 0600 env on the published port, accepted by ensure_runtime_env.sh"

# ---- B: psql absent ---------------------------------------------------------
: >"$CALLS"
rm -f "$OUT/runtime-db.env"
b_log="$SANDBOX/b.log"
if PATH="$BASE_PATH" MOMO_LIBPQ_BIN_DIRS="$EMPTY_LIBPQ" bash "$SCRIPTS/gate_runtime_db.sh" up >"$b_log" 2>&1; then
  fail "B: up must fail when psql is missing"
fi
grep -q 'psql not found' "$b_log" || fail "B: failure did not name psql"
if grep -q '^run ' "$CALLS"; then fail "B: a container was started before the psql check"; fi
pass "B psql absent: named failure before any container starts"

# ---- C: down ----------------------------------------------------------------
printf 'momo-gate-pg-fixture\n' >"$OUT/runtime-db.container"
: >"$CALLS"
PATH="$BASE_PATH" DOCKER_STUB_LABEL="some-other-run" bash "$SCRIPTS/gate_runtime_db.sh" down >/dev/null 2>&1 \
  || fail "C: down must be idempotent"
if grep -q '^rm ' "$CALLS"; then fail "C: down removed a container that does not carry this run's label"; fi
printf 'momo-gate-pg-fixture\n' >"$OUT/runtime-db.container"
: >"$CALLS"
PATH="$BASE_PATH" DOCKER_STUB_LABEL="test-run-4386" bash "$SCRIPTS/gate_runtime_db.sh" down >/dev/null 2>&1
grep -q '^rm -f momo-gate-pg-fixture' "$CALLS" || fail "C: down did not remove the run's own container"
# --keep must leave the container alone (and the state file for a later down).
printf 'momo-gate-pg-fixture\n' >"$OUT/runtime-db.container"
: >"$CALLS"
PATH="$BASE_PATH" DOCKER_STUB_LABEL="test-run-4386" bash "$SCRIPTS/gate_runtime_db.sh" down --keep >/dev/null 2>&1 \
  || fail "C: down --keep must succeed"
if grep -q '^rm ' "$CALLS"; then fail "C: down --keep removed the container"; fi
[ -f "$OUT/runtime-db.container" ] || fail "C: down --keep dropped the state file a later down needs"
# A boot that dies before readiness must still be removable: the container name is
# recorded before the readiness wait, so the interrupt/cleanup path can find it.
rm -f "$OUT/runtime-db.container" "$OUT/runtime-db.env"
: >"$CALLS"
if PATH="$BASE_PATH" MOMO_LIBPQ_BIN_DIRS="$LIBPQ" DOCKER_STUB_EXEC_FAIL=1 GATE_RUNTIME_DB_BOOT_TIMEOUT=1 \
  bash "$SCRIPTS/gate_runtime_db.sh" up >/dev/null 2>&1; then
  fail "C: up must fail when PostgreSQL never becomes ready"
fi
[ -s "$OUT/runtime-db.container" ] || fail "C: the container name was not recorded before the readiness wait"
: >"$CALLS"
PATH="$BASE_PATH" DOCKER_STUB_LABEL="test-run-4386" bash "$SCRIPTS/gate_runtime_db.sh" down >/dev/null 2>&1
grep -q '^rm -f momo-gate-pg-' "$CALLS" || fail "C: a boot that failed before readiness left its container behind"
pass "C down: removes only the container labelled with this run; --keep keeps; a half-booted run is still found"

# ---- D: local_gate.sh wiring ------------------------------------------------
# Structural, not behavioural: local_gate.sh cannot be executed here (its static
# lane alone runs ~70 heavy commands). So every assertion reads the source with
# comment lines removed (a commented-out call must not satisfy it), pins the exact
# command strings, and ties the two files together (env file name, output dir).
# The behavioural proof is the real clean-machine `--profile runtime-db` run in the
# PR body. What this cannot see: a runtime ordering bug between steps.
GATE="${UNDER_TEST_GATE:-$REPO_ROOT/scripts/local_gate.sh}"
# `grep -q` closes the pipe early; qgrep reads to the end instead, so no SIGPIPE noise.
qgrep() { grep "$@" >/dev/null; }
nocomment() { grep -Ev '^[[:space:]]*#' "$1"; }
GATE_CODE="$(nocomment "$GATE")"
block="$(printf '%s\n' "$GATE_CODE" | awk '/^  runtime-db\)$/{f=1;next} f&&/^    ;;$/{f=0} f')"
[ -n "$block" ] || fail "D: could not find the runtime-db profile block"
up_n="$(printf '%s\n' "$block" | grep -n '^    add_runtime_gate_db_up_command$' | head -n1 | cut -d: -f1)"
guard_n="$(printf '%s\n' "$block" | grep -n '^    add_runtime_env_guard_command$' | head -n1 | cut -d: -f1)"
[ -n "$up_n" ] && [ -n "$guard_n" ] && [ "$up_n" -lt "$guard_n" ] \
  || fail "D: the gate DB must come up (uncommented) before the env guard that reads ENV_FILE"
upfn="$(printf '%s\n' "$GATE_CODE" | awk '/^add_runtime_gate_db_up_command\(\) \{$/{f=1} f{print} f&&/^}$/{f=0}')"
printf '%s\n' "$upfn" | qgrep -F 'add_cmd_once "$RUNTIME_GATE_DB_UP_LABEL" "bash scripts/gate_runtime_db.sh up"' \
  || fail "D: the up step is not exactly 'bash scripts/gate_runtime_db.sh up'"
printf '%s\n' "$upfn" | qgrep -E '^  add_final_cleanup_cmd "remove gate-owned runtime DB" "bash scripts/gate_runtime_db.sh down\$\(\[ "\$KEEP_STACK" -eq 1 \] && printf '"' --keep'"'\)"$' \
  || fail "D: no final cleanup step removes the gate-owned DB"
printf '%s\n' "$GATE_CODE" | qgrep -Fx '[ "$PROFILE" = "runtime-db" ] && RUNTIME_GATE_DB=1' \
  || fail "D: RUNTIME_GATE_DB is not switched on exactly for the runtime-db profile"
boot="$(printf '%s\n' "$GATE_CODE" | awk '/^add_runtime_bootstrap_commands\(\) \{$/{f=1} f{print} f&&/^}$/{f=0}')"
printf '%s\n' "$boot" | qgrep -F 'if [ "$RUNTIME_GATE_DB" -eq 1 ]; then' || fail "D: bootstrap does not branch on the gate-owned DB"
# `make up` must be reachable only from the non-gate-DB branch.
printf '%s\n' "$boot" | awk '/if \[ "\$RUNTIME_GATE_DB" -eq 1 \]/{g=1} /^  else$/{g=0;e=1} e&&/make up/{ok=1} g&&/make up/{bad=1} END{exit !(ok&&!bad)}' \
  || fail "D: make up is still reachable on the runtime-db path"
# ENV_FILE: exactly one export, inside run_cmd, gated on the up step's label.
[ "$(printf '%s\n' "$GATE_CODE" | grep -c 'export ENV_FILE=')" = "1" ] \
  || fail "D: ENV_FILE must be exported in exactly one place (a global export leaks it into static steps)"
printf '%s\n' "$GATE_CODE" | awk '/^run_cmd\(\) \{$/{f=1} f&&/^}$/{f=0} f' \
  | qgrep -F 'export ENV_FILE="$RUNTIME_GATE_DB_ENV_FILE"' || fail "D: the ENV_FILE export is not inside run_cmd"
printf '%s\n' "$GATE_CODE" | awk '/^run_cmd\(\) \{$/{f=1} f&&/^}$/{f=0} f' \
  | qgrep -Fx '    if [ "$RUNTIME_GATE_DB" -eq 1 ] && [ "$label" = "$RUNTIME_GATE_DB_UP_LABEL" ]; then' || fail "D: the ENV_FILE export is not tied to the up step passing"
# The env file the gate expects is the one the script writes, in the same directory.
gate_env_name="$(printf '%s\n' "$GATE_CODE" | sed -n 's|^RUNTIME_GATE_DB_ENV_FILE="\$RUN_ARTIFACT_DIR/\(.*\)"$|\1|p')"
script_env_name="$(nocomment "$SCRIPTS/gate_runtime_db.sh" | sed -n 's|^ENV_OUT="\$OUT_DIR/\(.*\)"$|\1|p')"
[ -n "$gate_env_name" ] && [ "$gate_env_name" = "$script_env_name" ] \
  || fail "D: local_gate expects '$gate_env_name' but gate_runtime_db.sh writes '$script_env_name'"
printf '%s\n' "$GATE_CODE" | qgrep -Fx 'export LOCAL_GATE_OUTPUT_DIR="$RUN_ARTIFACT_DIR"' \
  || fail "D: gate_runtime_db.sh would write somewhere other than RUN_ARTIFACT_DIR"
# Interrupt teardown: inside the emergency-cleanup function, on the live path.
cleanup_fn="$(printf '%s\n' "$GATE_CODE" | awk '/local_gate_emergency_cleanup\(\) \{$/{f=1} f{print} f&&/^    }$/{f=0}')"
printf '%s\n' "$cleanup_fn" | qgrep -F 'if [ "$RUNTIME_GATE_DB" -eq 1 ] && [ "$KEEP_STACK" -eq 0 ]; then' \
  || fail "D: emergency cleanup does not tear the gate DB down when it is not kept"
printf '%s\n' "$cleanup_fn" | qgrep -E '^[[:space:]]+bash "\$REPO_ROOT/scripts/gate_runtime_db.sh" down 2>&1 \| tee -a "\$LOG_FILE" \|\| true$' || fail "D: emergency cleanup never calls gate_runtime_db.sh down"
printf '%s\n' "$GATE_CODE" | qgrep -Fx '    trap local_gate_emergency_cleanup EXIT' || fail "D: emergency cleanup is not installed on EXIT"
pass "D local_gate wiring: DB up before env guard, no make up on runtime-db, single scoped ENV_FILE export, shared env filename, interrupt teardown"

# ---- E: owner bootstrap env covers compose's required variables --------------
OB="$SCRIPTS/verify_owner_bootstrap_rust.sh"
heredoc_keys="$(awk '/cat >"\$ENV_FILE" <<EOF/{f=1;next} /^EOF$/{f=0} f' "$OB" | sed -n 's/^\([A-Z_0-9]*\)=.*/\1/p' | sort -u)"
required="$(awk '
  /^  [a-z][a-z0-9-]*:$/ { svc = ($1 == "runtime-roles:" || $1 == "migrate:") }
  svc { line = $0; while (match(line, /\$\{[A-Z_0-9]+:\?/)) { print substr(line, RSTART+2, RLENGTH-4); line = substr(line, RSTART+RLENGTH) } }
' "$COMPOSE" | sort -u)"
[ -n "$required" ] || fail "E: found no required variables in runtime-roles/migrate (parser drift)"
missing="$(comm -23 <(printf '%s\n' "$required") <(printf '%s\n' "$heredoc_keys") | tr '\n' ' ')"
[ -z "$missing" ] || fail "E: verify_owner_bootstrap_rust.sh env lacks compose-required: $missing"
grep -Eq '^NOTIFIER_DATABASE_URL=postgres://momo_notifier:\$NOTIFIER_PASSWORD@postgres:5432/momo$' "$OB" \
  || fail "E: NOTIFIER_DATABASE_URL must carry the same generated password as NOTIFIER_POSTGRES_PASSWORD"
grep -Eq '^NOTIFIER_POSTGRES_PASSWORD=\$NOTIFIER_PASSWORD$' "$OB" || fail "E: NOTIFIER_POSTGRES_PASSWORD is not the generated password"
pass "E owner-bootstrap env: every runtime-roles/migrate required variable present, notifier pair consistent"

# ---- F: t3 repair verifier ---------------------------------------------------
T3="$SCRIPTS/verify_t3_migration_repair.sh"
tool_line="$(grep -E '^for tool in ' "$T3")"
case "$tool_line" in *" swift"*) fail "F: retired swift toolchain is still required: $tool_line" ;; esac
case "$tool_line" in *" cargo"*) ;; *) fail "F: cargo (what the server boot really uses) is not required: $tool_line" ;; esac
env_block="$(grep -Ev '^[[:space:]]*#' "$T3" | awk '/^SERVER_PORT=/{f=1} f{print} /cargo run --manifest-path/{exit}')"
printf '%s\n' "$env_block" | grep -q 'WEBHOOK_INGRESS_MASTER_KEY=' || fail "F: momo-server boots without WEBHOOK_INGRESS_MASTER_KEY"
printf '%s\n' "$env_block" | grep -q 'OUTBOUND_WEBHOOK_MASTER_KEY=' || fail "F: momo-server boots without OUTBOUND_WEBHOOK_MASTER_KEY"
printf '%s\n' "$env_block" | grep -q 'JWT_HMAC=' || fail "F: momo-server boots without JWT_HMAC (MissingJwtSecret, seen on a real run)"
pass "F t3 repair: no swift requirement, JWT secret and both webhook master keys reach the booted server"

# ---- G: huddle verifier accepts keg-only libpq -------------------------------
# docker/cargo stubs let the script run through; psql only exists in the fake libpq dir.
HD="$SCRIPTS/verify_huddle_lifecycle.sh"
: >"$CALLS"
g_log="$SANDBOX/g.log"
PATH="$BASE_PATH" MOMO_LIBPQ_BIN_DIRS="$LIBPQ" HUDDLE_GATE_BOOT_TIMEOUT=1 HUDDLE_GATE_PROJECT="t4386-$$" \
  bash "$HD" >"$g_log" 2>&1 || true
grep -q 'psql not found' "$g_log" && fail "G: huddle verifier refused a machine whose psql lives only in the libpq dir"
grep -q '^run ' "$CALLS" || fail "G: huddle verifier never reached docker run (stopped earlier: $(tail -n 2 "$g_log" | tr '\n' ' '))"
: >"$CALLS"
PATH="$BASE_PATH" MOMO_LIBPQ_BIN_DIRS="$EMPTY_LIBPQ" HUDDLE_GATE_PROJECT="t4386-$$" bash "$HD" >"$SANDBOX/g2.log" 2>&1 && fail "G: huddle verifier must fail without any psql"
grep -q 'psql not found' "$SANDBOX/g2.log" || fail "G: missing psql was not reported by name"
if grep -q '^run ' "$CALLS"; then fail "G: huddle verifier started a container without psql"; fi
pass "G huddle: keg-only libpq accepted, truly missing psql refused by name before docker run"

echo "[runtime-db-gate-test] ALL PASS"
