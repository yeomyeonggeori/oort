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
  infra/prod/member_list.sql infra/prod/create_invite.sql \
  infra/prod/create_workspace.sql; do
  [ -f "$path" ] || fail "missing MOMO-560/571 artifact: $path"
done

bash -n "$OPS"
sh -n "$ENTRYPOINT"
grep -Fq 'run_prod_preflight' "$OPS" || fail "operator wrapper lost production preflight reuse"
grep -Fq 'migrate member-list' "$OPS" || fail "member list is not routed through migrate image"
grep -Fq 'migrate invite-create' "$OPS" || fail "invite creation is not routed through migrate image"
# MOMO-584: the operator deep link contract shared verbatim with the macOS client (585).
# goal B13: minted as oort:// since the rebrand. The old scheme is still ACCEPTED
# by every client, but nothing may still MINT it — that is what this asserts.
grep -Fq 'oort://join?server=' "$OPS" ||
  fail "invite-create no longer emits the oort://join deep link"
if grep -Fq 'deeplink="momo://join' "$OPS"; then
  fail "invite-create still mints the pre-rebrand momo://join deep link"
fi
grep -Fq 'migrate workspace-create' "$OPS" || fail "workspace creation is not routed through migrate image"
grep -Fq '\getenv invite_code MOMO_OPS_INVITE_CODE' infra/prod/create_invite.sql ||
  fail "invite SQL does not use env-only bearer input"
grep -Fq 'momo_invite_code_hash(input.raw_code)' infra/prod/create_invite.sql ||
  fail "invite SQL does not hash the bearer code before persistence"
# MOMO-571 W-3: invites must never mint an owner (owner transfer is a distinct act).
grep -Fq "input.invite_role = 'owner'" infra/prod/create_invite.sql ||
  fail "invite SQL does not reject the owner role"
# MOMO-571 W-1: workspace-create owner password is env-only and never selected.
grep -Fq '\getenv owner_password MOMO_OPS_OWNER_PASSWORD' infra/prod/create_workspace.sql ||
  fail "workspace SQL does not use env-only owner password input"
grep -Fq 'momo_password_hash(input.password)' infra/prod/create_workspace.sql ||
  fail "workspace SQL does not hash the owner password before persistence"
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
if [[ " $* " == *' run --rm --no-deps '* ]] && [[ " $* " == *' workspace-create '* ]]; then
  [ -n "${MOMO_OPS_WORKSPACE_NAME:-}" ] || exit 11
  [ -n "${MOMO_OPS_WORKSPACE_SLUG:-}" ] || exit 12
  [ -n "${MOMO_OPS_OWNER_EMAIL:-}" ] || exit 13
  [ -n "${MOMO_OPS_OWNER_PASSWORD:-}" ] || exit 14
  printf 'workspace-create-ok\n'
fi
SH

chmod +x "$TMP_ROOT/repo/infra/prod/momo-ops.sh" \
  "$TMP_ROOT/repo/infra/prod/upgrade.sh" \
  "$TMP_ROOT/repo/scripts/prod_env_preflight.sh" \
  "$TMP_ROOT/bin/docker"

PLACEHOLDER_ENV="$TMP_ROOT/placeholder.env"
VALID_ENV="$TMP_ROOT/valid.env"
printf 'POSTGRES_PASSWORD=change-me-postgres\n' > "$PLACEHOLDER_ENV"
{ printf 'MOMO_ENV=prod\n'; printf 'PUBLIC_BASE_URL=https://api.momo-ops.test\n'; } > "$VALID_ENV"
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
# The bearer code must never reach the container argv/trace (system-visible via ps).
if grep -Fq "$INVITE_CODE" "$TRACE"; then
  fail "raw invite code leaked into container argv trace"
fi
# MOMO-584: invite-create emits an oort://join deep link on stdout for operator
# delivery. server is the percent-encoded PUBLIC_BASE_URL; code is the invite code.
grep -Eq '^oort://join\?server=https%3A%2F%2Fapi\.momo-ops\.test&code=' "$TMP_ROOT/invite.out" ||
  fail "invite-create did not emit the oort://join deep link with a percent-encoded server URL"
grep -Fq "oort://join?server=https%3A%2F%2Fapi.momo-ops.test&code=$INVITE_CODE" "$TMP_ROOT/invite.out" ||
  fail "invite deep link did not carry the exact invite code"
# The code may appear on stdout only inside that deep link, never as a bare value.
if grep -F "$INVITE_CODE" "$TMP_ROOT/invite.out" | grep -vq '^oort://join'; then
  fail "invite code appeared on stdout outside the deep link"
fi
if run_ops invite-create --env-file "$VALID_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  --output "$INVITE_FILE" > "$TMP_ROOT/invite-overwrite.out" 2>&1; then
  fail "invite-create overwrote an existing secret file"
fi
pass "invite deep link is emitted on stdout while the bare code stays file-only and off argv"

# MOMO-584: --server-url overrides the env default and is percent-encoded.
: > "$TRACE"
INVITE_FILE2="$TMP_ROOT/invite2.secret"
run_ops invite-create --env-file "$VALID_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  --server-url 'http://192.0.2.10:28180' --output "$INVITE_FILE2" \
  > "$TMP_ROOT/invite2.out" 2>&1 ||
  fail "invite-create with --server-url failed"
grep -Fq 'oort://join?server=http%3A%2F%2F192.0.2.10%3A28180&code=' "$TMP_ROOT/invite2.out" ||
  fail "--server-url was not percent-encoded into the deep link"
pass "--server-url overrides PUBLIC_BASE_URL and is percent-encoded in the deep link"

# MOMO-584: reject a malformed --server-url before any Docker side effect.
: > "$TRACE"
if run_ops invite-create --env-file "$VALID_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  --server-url 'not-a-url' --output "$TMP_ROOT/invite-bad.secret" \
  > "$TMP_ROOT/invite-bad.out" 2>&1; then
  fail "invite-create accepted a malformed --server-url"
fi
[ ! -s "$TRACE" ] || fail "malformed --server-url touched Docker before validation"
[ ! -e "$TMP_ROOT/invite-bad.secret" ] || fail "malformed --server-url reserved an output file"
pass "invite-create rejects a malformed --server-url before Docker"

# MOMO-584: fail closed before any durable side effect when no base URL is available.
: > "$TRACE"
NO_BASE_ENV="$TMP_ROOT/nobase.env"
printf 'MOMO_ENV=prod\n' > "$NO_BASE_ENV"
INVITE_FILE3="$TMP_ROOT/invite3.secret"
if run_ops invite-create --env-file "$NO_BASE_ENV" \
  --workspace-id 00000000-0000-7000-8000-000000000001 \
  --output "$INVITE_FILE3" > "$TMP_ROOT/invite3.out" 2>&1; then
  fail "invite-create created an invite without a resolvable base URL"
fi
[ ! -e "$INVITE_FILE3" ] || fail "invite-create reserved an output file before the base URL check"
if grep -Fq 'migrate invite-create' "$TRACE"; then
  fail "invite-create reached the DB path without a base URL"
fi
grep -Fq 'PUBLIC_BASE_URL' "$TMP_ROOT/invite3.out" ||
  fail "missing base URL failure was not actionable"
pass "invite-create fails closed before the DB path when no base URL is available"

# MOMO-571 W-1: workspace-create is env-only and fails closed on missing inputs.
: > "$TRACE"
if run_ops workspace-create --from-env > "$TMP_ROOT/wsc-missing.out" 2>&1; then
  fail "workspace-create succeeded without required environment inputs"
fi
[ ! -s "$TRACE" ] || fail "workspace-create touched Docker before fail-closed validation"
grep -Fq 'MOMO_OPS_WORKSPACE_NAME' "$TMP_ROOT/wsc-missing.out" ||
  fail "workspace-create missing-input failure was not actionable"

: > "$TRACE"
WSC_PASSWORD="w0rkspace-owner-$$-secret"
if MOMO_OPS_WORKSPACE_NAME="Acme Alpha" \
   MOMO_OPS_WORKSPACE_SLUG="acme-alpha" \
   MOMO_OPS_OWNER_EMAIL="owner@acme.test" \
   MOMO_OPS_OWNER_PASSWORD="$WSC_PASSWORD" \
   run_ops workspace-create --from-env > "$TMP_ROOT/wsc.out" 2>&1; then
  :
else
  fail "workspace-create mock path failed with valid inputs"
fi
grep -Fq 'migrate workspace-create' "$TRACE" || fail "workspace-create did not use migrate image"
grep -Fq 'workspace-create-ok' "$TMP_ROOT/wsc.out" || fail "workspace-create output was lost"
if grep -Fq "$WSC_PASSWORD" "$TRACE" || grep -Fq "$WSC_PASSWORD" "$TMP_ROOT/wsc.out"; then
  fail "owner password leaked into argv/stdout trace"
fi
# The slug is passed as an env passthrough (-e NAME), never interpolated into argv.
if grep -Fq 'acme-alpha' "$TRACE"; then
  fail "workspace slug value leaked into container argv"
fi
pass "workspace-create is env-only, fails closed, and keeps the owner password off argv/stdout"

run_ops upgrade --env-file "$VALID_ENV" --backup-evidence "$TMP_ROOT/pass.md" \
  > "$TMP_ROOT/upgrade.out" 2>&1
grep -Fq "upgrade-args=--env-file $VALID_ENV --backup-evidence $TMP_ROOT/pass.md" \
  "$TMP_ROOT/upgrade.out" || fail "upgrade arguments were not delegated unchanged"
pass "upgrade delegates to the existing guarded upgrade implementation"

echo "PASS: momo-ops static/mocked contract"
