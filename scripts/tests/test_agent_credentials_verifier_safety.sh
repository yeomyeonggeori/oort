#!/usr/bin/env bash
# Daemon-free adversarial ownership/secret-argv fixture for #1358 verifier.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
VERIFIER="$REPO_ROOT/scripts/verify_agent_credentials_rust.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-agent-credential-safety.XXXXXX")"
FAKE_BIN="$TMP_ROOT/bin"
OWNED_ID="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

cleanup() {
  case "$TMP_ROOT" in "${TMPDIR:-/tmp}"/momo-agent-credential-safety.*) rm -rf "$TMP_ROOT" ;; *) exit 1 ;; esac
}
trap cleanup EXIT INT TERM
mkdir -p "$FAKE_BIN"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FAKE_BIN/psql"
cat >"$FAKE_BIN/cargo" <<'SH'
#!/usr/bin/env bash
printf 'cargo invoked\n' >>"$FAKE_DOCKER_STATE/cargo.log"
exit "${FAKE_CARGO_RC:-77}"
SH
cat >"$FAKE_BIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
STATE="${FAKE_DOCKER_STATE:?}"
SCENARIO="${FAKE_DOCKER_SCENARIO:-valid}"
OWNED_ID="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
FOREIGN_ID="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
command_name="${1:-}"; [ "$#" -gt 0 ] && shift
printf '%s' "$command_name" >>"$STATE/argv.log"
for argument in "$@"; do printf ' <%s>' "$argument" >>"$STATE/argv.log"; done
printf '\n' >>"$STATE/argv.log"
case "$command_name" in
  run)
    name="" invocation=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -d) shift ;;
        --name) name="$2"; shift 2 ;;
        --label) case "$2" in com.momo.agent-credentials.invocation=*) invocation="${2#*=}" ;; esac; shift 2 ;;
        --env-file|-p) shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s' "$name" >"$STATE/name"; printf '%s' "$invocation" >"$STATE/invocation"
    if [ "$SCENARIO" = create-collision ]; then echo 'name is already in use' >&2; exit 125; fi
    printf 'present\n' >"$STATE/presence"
    if [ "$SCENARIO" = signal ]; then kill -TERM "$PPID"; sleep 1; fi
    printf '%s\n' "$OWNED_ID"
    ;;
  exec) [ "${1:-}" = "$OWNED_ID" ] || exit 92; exit 0 ;;
  inspect)
    [ "$SCENARIO" != list-error ] || exit 9
    [ "${1:-}" = --format ] || exit 93
    format="$2" target="$3" name="$(cat "$STATE/name")" invocation="$(cat "$STATE/invocation")"
    [ "$(cat "$STATE/presence" 2>/dev/null || true)" = present ] || exit 1
    if [ "$target" = "$OWNED_ID" ]; then
      case "$format" in
        '{{.Id}}') [ "$SCENARIO" = id-mismatch ] && printf '%s\n' "$FOREIGN_ID" || printf '%s\n' "$OWNED_ID" ;;
        *'.Id}}|'*)
          actual_id="$OWNED_ID"; actual_name="/$name"; actual_label="$invocation"
          [ "$SCENARIO" = id-mismatch ] && actual_id="$FOREIGN_ID"
          [ "$SCENARIO" = name-hijack ] && actual_name='/renamed-owned'
          [ "$SCENARIO" = label-hijack ] && actual_label='foreign-invocation'
          printf '%s|%s|%s\n' "$actual_id" "$actual_name" "$actual_label"
          ;;
        *) exit 94 ;;
      esac
    elif [ "$target" = "$name" ] && [ "$format" = '{{.Id}}' ]; then
      [ "$SCENARIO" = name-hijack ] && printf '%s\n' "$FOREIGN_ID" || printf '%s\n' "$OWNED_ID"
    else exit 95; fi
    ;;
  ps)
    [ "$SCENARIO" != list-error ] || exit 9
    [ "$(cat "$STATE/presence" 2>/dev/null || true)" = present ] && printf '%s\n' "$OWNED_ID"
    exit 0
    ;;
  rm)
    printf '%s\n' "$*" >>"$STATE/rm.log"
    [ "$SCENARIO" = rm-lie ] || printf 'absent\n' >"$STATE/presence"
    ;;
  *) echo "unexpected fake docker command: $command_name $*" >&2; exit 96 ;;
esac
SH
chmod +x "$FAKE_BIN/psql" "$FAKE_BIN/cargo" "$FAKE_BIN/docker"

LAST_STATE="" LAST_OUTPUT="" LAST_RC=0
run_case() {
  local name="$1" scenario="$2" cargo_rc="$3"
  LAST_STATE="$TMP_ROOT/$name"; LAST_OUTPUT="$LAST_STATE/output.log"; mkdir -p "$LAST_STATE"
  set +e
  PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
    FAKE_DOCKER_STATE="$LAST_STATE" FAKE_DOCKER_SCENARIO="$scenario" FAKE_CARGO_RC="$cargo_rc" \
    AGENT_CREDENTIALS_RUST_PROJECT=safety-fixture AGENT_CREDENTIALS_RUST_PG_PORT=25438 \
    "$VERIFIER" >"$LAST_OUTPUT" 2>&1
  LAST_RC=$?; set -e
}
assert_random_ownership_shape() {
  local name invocation nonce
  name="$(cat "$1/name")"; invocation="$(cat "$1/invocation")"; nonce="${name#safety-fixture-}"; nonce="${nonce%-pg}"
  [[ "$name" =~ ^safety-fixture-[0-9a-f]{32}-pg$ ]] || exit 1
  [ "$invocation" = "$nonce" ] || exit 1
}

run_case valid-a valid 77
[ "$LAST_RC" -eq 77 ]; assert_random_ownership_shape "$LAST_STATE"
[ "$(cat "$LAST_STATE/rm.log")" = "-f -v $OWNED_ID" ] && [ "$(cat "$LAST_STATE/presence")" = absent ]
FIRST_NAME="$(cat "$LAST_STATE/name")"
run_case valid-b valid 77
[ "$LAST_RC" -eq 77 ]; assert_random_ownership_shape "$LAST_STATE"; [ "$(cat "$LAST_STATE/name")" != "$FIRST_NAME" ]
run_case valid-pass valid 0
[ "$LAST_RC" -eq 0 ]; assert_random_ownership_shape "$LAST_STATE"
[ "$(cat "$LAST_STATE/presence")" = absent ]
grep -Fq '[agent-credentials-rust] PASS' "$LAST_OUTPUT"

for scenario in name-hijack label-hijack id-mismatch; do
  run_case "$scenario" "$scenario" 0
  [ "$LAST_RC" -eq 1 ] && [ ! -e "$LAST_STATE/rm.log" ]
  grep -Fq 'cleanup ownership check failed; refusing container removal' "$LAST_OUTPUT"
done
run_case list-error list-error 0
[ "$LAST_RC" -eq 1 ] && [ ! -e "$LAST_STATE/rm.log" ]
run_case rm-lie rm-lie 0
[ "$LAST_RC" -eq 1 ] && [ "$(cat "$LAST_STATE/presence")" = present ]
run_case signal signal 0
[ "$LAST_RC" -eq 143 ]; assert_random_ownership_shape "$LAST_STATE"
[ "$(cat "$LAST_STATE/presence")" = absent ] && [ "$(cat "$LAST_STATE/rm.log")" = "-f -v $OWNED_ID" ]
run_case create-collision create-collision 0
[ "$LAST_RC" -ne 0 ] && [ ! -e "$LAST_STATE/rm.log" ] && [ ! -e "$LAST_STATE/cargo.log" ]

# External/prod-looking databases and retained live stacks are never primary
# evidence. Secrets are passed to Docker only through a 0600 env file.
set +e
DATABASE_URL='postgres://prod.example.invalid/live' "$VERIFIER" >"$TMP_ROOT/prod.log" 2>&1; prod_rc=$?
AGENT_CREDENTIALS_RUST_KEEP_STACK=1 "$VERIFIER" >"$TMP_ROOT/keep.log" 2>&1; keep_rc=$?
set -e
[ "$prod_rc" -ne 0 ] && grep -Fq 'isolated Docker is mandatory' "$TMP_ROOT/prod.log"
[ "$keep_rc" -ne 0 ] && grep -Fq 'non-evidence' "$TMP_ROOT/keep.log"
if grep -R -E 'POSTGRES_PASSWORD=|postgres://[^ ]+:[^ ]+@' "$TMP_ROOT" --include='output.log' --include='argv.log' >/dev/null; then
  echo 'password-bearing argv/output detected' >&2; exit 1
fi
if grep -F '.arg(database_url())' "$REPO_ROOT/server-rust/bins/momo-server/tests/agent_credential_conformance_pg.rs" >/dev/null; then
  echo 'psql receives password-bearing database URL via argv' >&2; exit 1
fi

echo "[agent-credential-safety] PASS mutation/signal + tri-state ownership + immutable teardown"
