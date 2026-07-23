#!/usr/bin/env bash
# Static/mocked MOMO-560 day-2 operator contract. No Docker daemon or secret.
set -euo pipefail

fail() {
  printf '[momo-ops-static] FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf '[momo-ops-static] PASS: %s\n' "$*"
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "must run inside the repository"
cd "$REPO_ROOT"

OPS="infra/prod/momo-ops.sh"
ENTRYPOINT="infra/prod/docker/internal-smoke-migrate.sh"
DOCKERFILE="infra/prod/docker/internal-smoke-migrate.Dockerfile"
for path in "$OPS" "$ENTRYPOINT" "$DOCKERFILE" \
  infra/prod/member_list.sql infra/prod/create_invite.sql; do
  [ -f "$path" ] || fail "missing MOMO-560 artifact: $path"
done

bash -n "$OPS"
sh -n "$ENTRYPOINT"
grep -Fq 'run_prod_preflight' "$OPS" || fail "operator wrapper lost production preflight reuse"
grep -Fq 'migrate member-list' "$OPS" || fail "member list is not routed through migrate image"
grep -Fq 'migrate invite-create' "$OPS" || fail "invite creation is not routed through migrate image"
grep -Fq '\getenv invite_code MOMO_OPS_INVITE_CODE' infra/prod/create_invite.sql ||
  fail "invite SQL does not use env-only bearer input"
grep -Fq 'momo_invite_code_hash(input.raw_code)' infra/prod/create_invite.sql ||
  fail "invite SQL does not hash the bearer code before persistence"
if grep -Eq '(^|[[:space:]])(-c|--command)[[:space:]]' "$OPS"; then
  fail "database operation must not interpolate credentials or values into psql command text"
fi
pass "shell and env-only DB source contracts are present"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo560.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/repo/infra/prod" "$TMP_ROOT/repo/scripts" "$TMP_ROOT/bin"
cp "$OPS" infra/prod/deploy-lib.sh "$TMP_ROOT/repo/infra/prod/"

cat > "$TMP_ROOT/repo/infra/prod/upgrade.sh" <<'SH'
#!/usr/bin/env bash
printf 'upgrade-args=%s\n' "$*"
SH

cat > "$TMP_ROOT/repo/scripts/prod_env_preflight.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
env_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) env_file="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$env_file" ] && grep -Eqi 'change-me|__PLACEHOLDER__' "$env_file"; then
  echo "[preflight] placeholder rejected" >&2
  exit 1
fi
echo preflight >> "${MOMO560_PREFLIGHT_TRACE:?}"
SH

cat > "$TMP_ROOT/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MOMO560_DOCKER_TRACE:?}"
if [[ " $* " == *' run --rm --no-deps '* ]] && [[ " $* " == *' invite-create '* ]]; then
  [ -n "${MOMO_OPS_INVITE_CODE:-}" ] || exit 9
fi
if [[ " $* " == *' run --rm --no-deps '* ]] && [[ " $* " == *' member-list '* ]]; then
  printf 'member-list-ok\n'
fi
SH

chmod +x "$TMP_ROOT/repo/infra/prod/momo-ops.sh" \
  "$TMP_ROOT/repo/infra/prod/upgrade.sh" \
  "$TMP_ROOT/repo/scripts/prod_env_preflight.sh" \
  "$TMP_ROOT/bin/docker"

PLACEHOLDER_ENV="$TMP_ROOT/placeholder.env"
VALID_ENV="$TMP_ROOT/valid.env"
printf 'POSTGRES_PASSWORD=change-me-postgres\n' > "$PLACEHOLDER_ENV"
printf 'MOMO_ENV=prod\n' > "$VALID_ENV"
TRACE="$TMP_ROOT/docker.trace"
PREFLIGHT_TRACE="$TMP_ROOT/preflight.trace"
touch "$TRACE" "$PREFLIGHT_TRACE"
OPS_COPY="$TMP_ROOT/repo/infra/prod/momo-ops.sh"

run_ops() {
  PATH="$TMP_ROOT/bin:$PATH" \
    MOMO560_DOCKER_TRACE="$TRACE" \
    MOMO560_PREFLIGHT_TRACE="$PREFLIGHT_TRACE" \
    "$OPS_COPY" "$@"
}

run_ops status --env-file "$PLACEHOLDER_ENV" > "$TMP_ROOT/status.out" 2>&1 ||
  fail "status did not tolerate a placeholder environment"
[ ! -s "$PREFLIGHT_TRACE" ] || fail "status unexpectedly ran strict preflight"
grep -Fq 'ps' "$TRACE" || fail "status did not invoke compose ps"
pass "status is the only placeholder-safe read path"

: > "$TRACE"
if run_ops logs --env-file "$PLACEHOLDER_ENV" > "$TMP_ROOT/logs-placeholder.out" 2>&1; then
  fail "logs accepted a placeholder environment"
fi
[ ! -s "$TRACE" ] || fail "logs touched Docker before placeholder rejection"
grep -Fq 'placeholder rejected' "$TMP_ROOT/logs-placeholder.out" ||
  fail "logs placeholder failure was not actionable"
pass "non-status commands fail closed before Docker"

: > "$TRACE"
: > "$PREFLIGHT_TRACE"
run_ops member list --env-file "$VALID_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  > "$TMP_ROOT/member.out" 2>&1 ||
  fail "member list mock path failed"
grep -Fq 'migrate member-list' "$TRACE" || fail "member list did not use migrate image"
grep -Fq 'member-list-ok' "$TMP_ROOT/member.out" || fail "member list output was lost"
pass "member list uses the operator DB path"

: > "$TRACE"
INVITE_FILE="$TMP_ROOT/invite.secret"
run_ops invite-create --env-file "$VALID_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  --role guest --max-uses 2 --expires-days 3 --output "$INVITE_FILE" \
  > "$TMP_ROOT/invite.out" 2>&1 ||
  fail "invite-create mock path failed"
[ -s "$INVITE_FILE" ] || fail "invite-create did not write the one-time code"
[ "$(stat -f '%Lp' "$INVITE_FILE" 2>/dev/null || stat -c '%a' "$INVITE_FILE")" = "600" ] ||
  fail "invite output is not mode 0600"
INVITE_CODE="$(tr -d '\n' < "$INVITE_FILE")"
grep -Fq 'migrate invite-create' "$TRACE" || fail "invite create did not use migrate image"
if grep -Fq "$INVITE_CODE" "$TRACE" || grep -Fq "$INVITE_CODE" "$TMP_ROOT/invite.out"; then
  fail "raw invite code leaked into argv/stdout trace"
fi
if run_ops invite-create --env-file "$VALID_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  --output "$INVITE_FILE" > "$TMP_ROOT/invite-overwrite.out" 2>&1; then
  fail "invite-create overwrote an existing secret file"
fi
pass "invite bearer stays out of argv/stdout and is written once as mode 0600"

run_ops upgrade --env-file "$VALID_ENV" --backup-evidence "$TMP_ROOT/pass.md" \
  > "$TMP_ROOT/upgrade.out" 2>&1
grep -Fq "upgrade-args=--env-file $VALID_ENV --backup-evidence $TMP_ROOT/pass.md" \
  "$TMP_ROOT/upgrade.out" || fail "upgrade arguments were not delegated unchanged"
pass "upgrade delegates to the existing guarded upgrade implementation"

echo "PASS: momo-ops static/mocked contract"
