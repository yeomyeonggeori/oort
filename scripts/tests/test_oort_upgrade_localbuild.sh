#!/usr/bin/env bash
# Red proofs for #2260 — local-build upgrade rebuilds; digest still pulls.
# Rollback copy must not reprint the failed command.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
OORT="$REPO_ROOT/scripts/oort"
TEMPLATE="$SCRIPT_DIR/fixtures/oort-doctor/valid.env.template"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/oort-upgrade-localbuild.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[oort-upgrade-localbuild-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[oort-upgrade-localbuild-test] ok: $*"; }

[ -x "$OORT" ] || chmod +x "$OORT"
[ -f "$TEMPLATE" ] || fail "missing fixture template: $TEMPLATE"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

bash -n "$OORT" || fail "bash -n scripts/oort"
bash -n "$REPO_ROOT/scripts/lib/oort_day2.sh" || fail "bash -n oort_day2.sh"
bash -n "$SCRIPT_DIR/test_oort_upgrade_localbuild.sh" || fail "bash -n this harness"
pass "bash -n dispatcher, day-2 lib, and this harness"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x "$OORT" || fail "shellcheck scripts/oort"
  shellcheck -x "$REPO_ROOT/scripts/lib/oort_day2.sh" || fail "shellcheck oort_day2.sh"
  shellcheck -x "$SCRIPT_DIR/test_oort_upgrade_localbuild.sh" || fail "shellcheck this harness"
  pass "shellcheck clean"
else
  echo "[oort-upgrade-localbuild-test] shellcheck not installed — skipped"
fi

export OORT_ROOT="$REPO_ROOT"
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/oort_doctor.sh"
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/oort_common.sh"
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/lib/oort_day2.sh"

# -----------------------------------------------------------------------------
# 1. Function-unit: mode → command plan. Sabotage: local-build emitting pull.
# -----------------------------------------------------------------------------
plan_has() {
  local plan="$1" want="$2"
  printf '%s\n' "$plan" | grep -qx -- "$want"
}

PLAN_LOCAL="$(oort_upgrade_refresh_plan local-build)"
PLAN_DIGEST="$(oort_upgrade_refresh_plan published-digest)"

plan_has "$PLAN_LOCAL" build || fail "local-build plan missing build: $PLAN_LOCAL"
plan_has "$PLAN_LOCAL" "up -d --wait" || fail "local-build plan missing up -d --wait: $PLAN_LOCAL"
if plan_has "$PLAN_LOCAL" pull; then
  fail "sabotage: local-build plan still pulls (must rebuild): $PLAN_LOCAL"
fi
plan_has "$PLAN_DIGEST" pull || fail "digest plan missing pull: $PLAN_DIGEST"
plan_has "$PLAN_DIGEST" "up -d" || fail "digest plan missing up -d: $PLAN_DIGEST"
if plan_has "$PLAN_DIGEST" build; then
  fail "digest plan must not build: $PLAN_DIGEST"
fi
pass "refresh plan: local-build=build; digest=pull"

# -----------------------------------------------------------------------------
# 2. Function-unit: rollback copy ≠ failed command
# -----------------------------------------------------------------------------
OORT_DOCTOR_ENV="$SANDBOX/rollback.env"
ROLLBACK_LOCAL="$(
  oort_print_rollback oort:local local-build "$SANDBOX/sample.dump" 2>&1
)"
printf '%s\n' "$ROLLBACK_LOCAL" | grep -Fq '자동 롤백은 하지 않는다' || \
  fail "local rollback missing no-auto-rollback: $ROLLBACK_LOCAL"
printf '%s\n' "$ROLLBACK_LOCAL" | grep -Fq '이전 이미지 태그로 되돌릴 수 없다' || \
  fail "local rollback still claims a previous image tag: $ROLLBACK_LOCAL"
printf '%s\n' "$ROLLBACK_LOCAL" | grep -Fq 'git checkout' || \
  fail "local rollback missing git checkout: $ROLLBACK_LOCAL"
printf '%s\n' "$ROLLBACK_LOCAL" | grep -Fq "scripts/oort restore $SANDBOX/sample.dump" || \
  fail "local rollback missing restore dump: $ROLLBACK_LOCAL"
FAILED_LOCAL="scripts/oort upgrade --local-build --no-backup --yes --env $OORT_DOCTOR_ENV"
FAILED_LOCAL_YES="scripts/oort upgrade --local-build --yes --env $OORT_DOCTOR_ENV"
if printf '%s\n' "$ROLLBACK_LOCAL" | grep -Fqx "  $FAILED_LOCAL"; then
  fail "local rollback reprinted the failed command: $FAILED_LOCAL"
fi
if printf '%s\n' "$ROLLBACK_LOCAL" | grep -Fqx "  $FAILED_LOCAL_YES"; then
  fail "local rollback reprinted the failed command: $FAILED_LOCAL_YES"
fi

ROLLBACK_DIGEST="$(
  oort_print_rollback "ghcr.io/yeomyeonggeori/oort@sha256:deadbeef" published-digest 2>&1
)"
printf '%s\n' "$ROLLBACK_DIGEST" | grep -Fq \
  'scripts/oort upgrade --to ghcr.io/yeomyeonggeori/oort@sha256:deadbeef --no-backup --yes' || \
  fail "digest rollback missing --to previous: $ROLLBACK_DIGEST"
if printf '%s\n' "$ROLLBACK_DIGEST" | grep -Fq 'git checkout'; then
  fail "digest rollback must keep --to previous, not checkout: $ROLLBACK_DIGEST"
fi
pass "rollback copy: local-build ≠ failed upgrade; digest keeps --to previous"

# -----------------------------------------------------------------------------
# 3. CLI with fake docker: compose subcommand column
# -----------------------------------------------------------------------------
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
    "__TOKEN_WEB_PORT__": "18088",
    "__TOKEN_API_PORT__": "18080",
    "__TOKEN_CENT_PORT__": "18000",
}
for k, v in repl.items():
    text = text.replace(k, v)
open(dest, "w", encoding="utf-8").write(text)
PY
  chmod 600 "$dest"
}

FAKE_BIN="$SANDBOX/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/docker" <<'EOF'
#!/bin/sh
set -eu
log="${FAKE_DOCKER_LOG:-/tmp/fake-docker-upgrade.log}"
printf '%s\n' "$*" >>"$log"
if [ "${1:-}" = "volume" ] && [ "${2:-}" = "inspect" ]; then
  exit 0
fi
if [ "${1:-}" != "compose" ]; then
  echo "unexpected docker invocation: $*" >&2
  exit 3
fi
subcmd=""
skip=0
for arg in "$@"; do
  if [ "$skip" -eq 1 ]; then
    skip=0
    continue
  fi
  case "$arg" in
    compose) continue ;;
    --env-file|-p|-f|--file|--project-name) skip=1; continue ;;
    --env-file=*|--file=*|--project-name=*|-p?*|-f?*) continue ;;
    -*) continue ;;
    *) subcmd="$arg"; break ;;
  esac
done
fail_sub="${FAKE_COMPOSE_FAIL:-build}"
if [ "$subcmd" = "$fail_sub" ]; then
  echo "fake compose ${subcmd} refused (fixture)" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$FAKE_BIN/docker"

run_upgrade() {
  local stdout="$1" stderr="$2" log="$3"
  shift 3
  : >"$log"
  set +e
  PATH="$FAKE_BIN:$PATH" FAKE_DOCKER_LOG="$log" FAKE_COMPOSE_FAIL="${FAKE_COMPOSE_FAIL:-build}" \
    "$OORT" upgrade "$@" >"$stdout" 2>"$stderr"
  echo $?
  set -e
}

logged_subcmds() {
  python3 - "$1" <<'PY'
import sys
path = sys.argv[1]
for raw in open(path, encoding="utf-8"):
    args = raw.rstrip("\n").split()
    if not args or args[0] != "compose":
        continue
    i = 1
    sub = ""
    while i < len(args):
        a = args[i]
        if a in ("--env-file", "-p", "-f", "--file", "--project-name") and i + 1 < len(args):
            i += 2
            continue
        if a.startswith("--env-file=") or a.startswith("--file=") or a.startswith("--project-name="):
            i += 1
            continue
        if a.startswith("-p") and a != "-p":
            i += 1
            continue
        if a.startswith("-f") and a != "-f":
            i += 1
            continue
        if a.startswith("-"):
            i += 1
            continue
        sub = a
        break
    if sub:
        print(sub)
PY
}

VALID="$SANDBOX/valid.env"
materialize "$VALID"

# 3a. --local-build: compose build (not pull); rollback ≠ failed command
OUT="$SANDBOX/local-flag.out"
ERR="$SANDBOX/local-flag.err"
LOG="$SANDBOX/local-flag.docker"
FAKE_COMPOSE_FAIL=build
code="$(run_upgrade "$OUT" "$ERR" "$LOG" --env "$VALID" --yes --no-backup --local-build)"
[ "$code" != "0" ] || fail "local-build upgrade exited 0 against failing build"
SUBS="$(logged_subcmds "$LOG")"
printf '%s\n' "$SUBS" | grep -qx build || \
  fail "local-build CLI did not compose build: log=$(cat "$LOG") stderr=$(cat "$ERR")"
if printf '%s\n' "$SUBS" | grep -qx pull; then
  fail "sabotage: local-build CLI still compose pull: $(cat "$LOG")"
fi
grep -Fq 'compose build 가 실패했다' "$ERR" "$OUT" || \
  fail "local-build CLI did not name compose build failure: stderr=$(cat "$ERR")"
grep -Fq 'git checkout' "$ERR" "$OUT" || \
  fail "local-build CLI rollback missing git checkout: stderr=$(cat "$ERR")"
grep -Fq 'scripts/oort restore' "$ERR" "$OUT" || \
  fail "local-build CLI rollback missing restore: stderr=$(cat "$ERR")"
if grep -Fqx "  scripts/oort upgrade --local-build --no-backup --yes --env $VALID" "$ERR" "$OUT"; then
  fail "local-build CLI reprinted the failed command"
fi
pass "--local-build CLI builds (no pull) and prints a different rollback"

# 3b. env MOMO_SELF_HOST_MODE=local-build without --local-build flag
OUT="$SANDBOX/local-env.out"
ERR="$SANDBOX/local-env.err"
LOG="$SANDBOX/local-env.docker"
FAKE_COMPOSE_FAIL=build
code="$(run_upgrade "$OUT" "$ERR" "$LOG" --env "$VALID" --yes --no-backup)"
[ "$code" != "0" ] || fail "env local-build upgrade exited 0 against failing build"
SUBS="$(logged_subcmds "$LOG")"
printf '%s\n' "$SUBS" | grep -qx build || \
  fail "env local-build CLI did not compose build: log=$(cat "$LOG")"
if printf '%s\n' "$SUBS" | grep -qx pull; then
  fail "sabotage: env local-build CLI still compose pull: $(cat "$LOG")"
fi
pass "env MOMO_SELF_HOST_MODE=local-build without --local-build still builds"

# 3c. digest --to: compose pull (not build); rollback is --to previous
LIST_DIGEST="$(jq -r '.images.app.digest_list' "$REPO_ROOT/releases/latest.json")"
printf '%s' "$LIST_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "latest.json digest_list"
DIGEST_ENV="$SANDBOX/digest.env"
awk -v img="ghcr.io/yeomyeonggeori/oort@${LIST_DIGEST}" '
  index($0, "MOMO_SELF_HOST_MODE=") == 1 { print "MOMO_SELF_HOST_MODE=published-digest"; next }
  index($0, "MOMO_RUST_IMAGE=") == 1 { print "MOMO_RUST_IMAGE=" img; next }
  { print }
' "$VALID" >"$DIGEST_ENV"
chmod 600 "$DIGEST_ENV"
OUT="$SANDBOX/digest.out"
ERR="$SANDBOX/digest.err"
LOG="$SANDBOX/digest.docker"
FAKE_COMPOSE_FAIL=pull
code="$(run_upgrade "$OUT" "$ERR" "$LOG" --env "$DIGEST_ENV" --yes --no-backup --to "$LIST_DIGEST")"
[ "$code" != "0" ] || fail "digest upgrade exited 0 against failing pull"
SUBS="$(logged_subcmds "$LOG")"
printf '%s\n' "$SUBS" | grep -qx pull || \
  fail "digest CLI did not compose pull: log=$(cat "$LOG") stderr=$(cat "$ERR")"
if printf '%s\n' "$SUBS" | grep -qx build; then
  fail "digest CLI must not compose build: $(cat "$LOG")"
fi
grep -Fq 'compose pull 가 실패했다' "$ERR" "$OUT" || \
  fail "digest CLI did not name compose pull failure: stderr=$(cat "$ERR")"
grep -Fq "scripts/oort upgrade --to ghcr.io/yeomyeonggeori/oort@${LIST_DIGEST} --no-backup --yes" \
  "$ERR" "$OUT" || \
  fail "digest rollback missing --to previous: stderr=$(cat "$ERR")"
if grep -Fq 'git checkout' "$ERR" "$OUT"; then
  fail "digest rollback must not switch to checkout: stderr=$(cat "$ERR")"
fi
pass "digest --to CLI pulls (no build) and prints --to previous"

echo "[oort-upgrade-localbuild-test] PASS: $CASES case(s)"
