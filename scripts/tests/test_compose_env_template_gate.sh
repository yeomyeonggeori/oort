#!/usr/bin/env bash
# Isolated regression for the #1250 compose/env-template guard.
#
# A guard that is green on a healthy tree has proved nothing — a guard that
# always exits 0 is green too. Every case below either turns the guard RED for a
# named reason, or shows it staying GREEN where turning red would be a false
# alarm. Nothing here writes inside the repository: each case mutates a copy.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check_compose_env_templates.sh"
SANDBOX_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-compose-env-gate-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX_ROOT"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[compose-env-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[compose-env-test] ok: $*"; }

have_docker=0
docker compose version >/dev/null 2>&1 && have_docker=1

# A fresh copy of the tree the guard reads. `infra/` carries the relative mount
# paths compose resolves (`../centrifugo.json`), so it is copied whole.
new_tree() {
  local dir="$SANDBOX_ROOT/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp -R "$REPO_ROOT/infra" "$dir/infra"
  echo "$dir"
}

# Runs the guard and returns its combined output; never aborts the harness.
run_guard() {
  local root="$1"; shift
  set +e
  GUARD_OUT="$("$GUARD" --root "$root" "$@" 2>&1)"
  GUARD_STATUS=$?
  set -e
}

expect_red() {
  local what="$1" needle="$2"
  [ "$GUARD_STATUS" -ne 0 ] || fail "$what: guard stayed green
$GUARD_OUT"
  case "$GUARD_OUT" in
    *"$needle"*) ;;
    *) fail "$what: red, but never named '$needle'
$GUARD_OUT" ;;
  esac
}

# =============================================================================
# Case 1 — green on the real tree, with the docker cross-check live.
# =============================================================================
if [ "$have_docker" -eq 1 ]; then
  run_guard "$REPO_ROOT"
  [ "$GUARD_STATUS" -eq 0 ] || fail "guard is red on the current tree:
$GUARD_OUT"
  case "$GUARD_OUT" in
    *"9 rendering(s)"*) ;;
    *) fail "guard did not report the expected rendering count: $GUARD_OUT" ;;
  esac
  pass "green on the current tree, all 9 renderings statically checked and rendered by docker compose"
else
  echo "[compose-env-test] skip: docker compose is unavailable on this host"
fi

# =============================================================================
# Case 2 — the #1246 regression itself, reproduced and named.
#
# This is the exact shape that sat red from 2026-07-24: three keys a compose
# file requires, absent from its env template. The guard must name ALL THREE
# in one run. `docker compose config` names only the first, which is why that
# command alone was never going to be the guard. After #2142 the remaining
# table is infra/rust, so the fixture deletes keys from rust-smoke.env.example.
# =============================================================================
tree="$(new_tree reintroduce-1246)"
for key in JWT_HMAC CENT_TOKEN_HMAC PROVIDER_LINK_MASTER_KEY; do
  sed -i.bak "/^${key}=/d" "$tree/infra/rust/rust-smoke.env.example"
done
rm -f "$tree/infra/rust/rust-smoke.env.example.bak"
run_guard "$tree" --skip-docker
expect_red "#1246 reintroduced" "rust base stack"
for key in JWT_HMAC CENT_TOKEN_HMAC PROVIDER_LINK_MASTER_KEY; do
  case "$GUARD_OUT" in
    *"- $key   required at infra/rust/docker-compose.rust.yml:"*) ;;
    *) fail "#1246 reintroduced: $key was not reported with its compose location
$GUARD_OUT" ;;
  esac
done
pass "reintroducing the three #1246 keys is red, and all three are named with the line that requires them"

# =============================================================================
# Case 3 — a service gains a required variable and no template follows. This is
# the mechanism of every instance of the trap, stated forward instead of after
# the fact.
# =============================================================================
tree="$(new_tree new-required-var)"
sed -i.bak 's|^\(  api:\)$|\1\n    x-momo-test: ${A_KEY_NOBODY_ADDED:?set A_KEY_NOBODY_ADDED}|' \
  "$tree/infra/rust/docker-compose.rust.yml"
rm -f "$tree/infra/rust/docker-compose.rust.yml.bak"
run_guard "$tree" --skip-docker
expect_red "new required var" "A_KEY_NOBODY_ADDED"
pass "a new \${VAR:?} with no template line is red in every rendering that layers the file"

# =============================================================================
# Case 4 — the empty-value trap. `${VAR:?}` refuses an empty value exactly as it
# refuses an absent one, so a template line that ends in `=` is not an answer.
# A guard that only checked for the key's presence would pass this.
# =============================================================================
tree="$(new_tree empty-value)"
sed -i.bak 's|^JWT_HMAC=.*|JWT_HMAC=|' "$tree/infra/rust/rust-smoke.env.example"
rm -f "$tree/infra/rust/rust-smoke.env.example.bak"
run_guard "$tree" --skip-docker
expect_red "empty value" "JWT_HMAC"
pass "an empty template value is red, not a filled key"
if [ "$have_docker" -eq 1 ]; then
  run_guard "$tree"
  case "$GUARD_OUT" in
    *"required variable JWT_HMAC is missing a value"*) ;;
    *) fail "docker cross-check did not reproduce the empty-value refusal
$GUARD_OUT" ;;
  esac
  pass "docker compose agrees that an empty value is a missing value"
fi

# =============================================================================
# Case 5 — what only the docker pass can catch. A value that expands to nothing
# reads as a filled line to any static parser; compose evaluates it and finds
# emptiness. The two passes are not redundant.
# =============================================================================
if [ "$have_docker" -eq 1 ]; then
  tree="$(new_tree expands-to-empty)"
  sed -i.bak 's|^MOMO_RUST_IMAGE=.*|MOMO_RUST_IMAGE=${A_TAG_NOBODY_DEFINED}|' \
    "$tree/infra/rust/rust-smoke.env.example"
  rm -f "$tree/infra/rust/rust-smoke.env.example.bak"
  run_guard "$tree" --skip-docker
  [ "$GUARD_STATUS" -eq 0 ] ||
    fail "the static pass was expected to be fooled by a value that expands to empty
$GUARD_OUT"
  run_guard "$tree"
  expect_red "expands to empty" "MOMO_RUST_IMAGE"
  pass "a value that expands to empty passes the static read and is caught by the docker cross-check"
fi

# =============================================================================
# Case 6 — coverage. A compose file added outside the table would carry
# unchecked requirements; so would an env template nobody renders. Both are red,
# because a table that quietly stops covering the tree is the original failure
# in a new costume.
# =============================================================================
tree="$(new_tree untabled-compose)"
cat >"$tree/infra/rust/untabled.override.yml" <<'EOF'
services:
  api:
    environment:
      SOMETHING: ${AN_UNTABLED_REQUIREMENT:?set it}
EOF
run_guard "$tree" --skip-docker
expect_red "untabled compose file" "infra/rust/untabled.override.yml"
pass "a compose file with \${VAR:?} that no rendering names is red"

tree="$(new_tree untabled-template)"
printf 'SOME_KEY=some-value\n' >"$tree/infra/rust/orphan.env.example"
run_guard "$tree" --skip-docker
expect_red "untabled env template" "infra/rust/orphan.env.example"
pass "an env template no rendering uses is red"

tree="$(new_tree missing-allowlisted)"
# Forge a stale extra exemption in a copy of the guard so the exemption
# cannot outlive its file. The live table is path|reason (#2328); a gone
# path is still red.
guard_copy="$tree/check_compose_env_templates.sh"
awk '
  /^NON_COMPOSE_ENV_TEMPLATES=\($/ {
    print
    print "  \"infra/rust/gone.env.example|stale exemption for the regression harness\","
    next
  }
  { print }
' "$GUARD" >"$guard_copy"
chmod +x "$guard_copy"
set +e
GUARD_OUT="$("$guard_copy" --root "$tree" --skip-docker 2>&1)"
GUARD_STATUS=$?
set -e
expect_red "stale allowlist" "gone.env.example"
pass "an allowlisted non-compose template that disappears is red, so the exemption cannot outlive its file"

# #2328: dropping infra/.env.example from the exception table (and not
# adding a rendering row) is red — Coverage 2 now finds infra/*.env.example.
tree="$(new_tree drop-root-env-example)"
guard_copy="$tree/check_compose_env_templates.sh"
awk '
  BEGIN { skip = 0 }
  /^NON_COMPOSE_ENV_TEMPLATES=\($/ { print "NON_COMPOSE_ENV_TEMPLATES=()"; skip = 1; next }
  skip && /^\)/ { skip = 0; next }
  skip { next }
  { print }
' "$GUARD" >"$guard_copy"
chmod +x "$guard_copy"
set +e
GUARD_OUT="$("$guard_copy" --root "$tree" --skip-docker 2>&1)"
GUARD_STATUS=$?
set -e
expect_red "root env.example untabled" "infra/.env.example"
pass "infra/.env.example without a table row or exemption is red"

# A reason-less exemption is not an exemption (#1250 hatch).
tree="$(new_tree exemption-no-reason)"
guard_copy="$tree/check_compose_env_templates.sh"
awk '
  BEGIN { skip = 0 }
  /^NON_COMPOSE_ENV_TEMPLATES=\($/ { print; print "  \"infra/.env.example\","; skip = 1; next }
  skip && /^\)/ { print; skip = 0; next }
  skip { next }
  { print }
' "$GUARD" >"$guard_copy"
chmod +x "$guard_copy"
set +e
GUARD_OUT="$("$guard_copy" --root "$tree" --skip-docker 2>&1)"
GUARD_STATUS=$?
set -e
expect_red "exemption without reason" "has no reason"
pass "NON_COMPOSE_ENV_TEMPLATES row without a reason is red"

# =============================================================================
# Case 7 — the guard must not invent requirements. Two false alarms it would be
# easy to write: prose in a YAML comment that mentions the idiom (which
# docker-compose.push.yml really does), and an optional `${VAR:-default}`.
# =============================================================================
tree="$(new_tree no-false-alarm)"
{
  printf '\n# A comment that mentions ${A_DOCUMENTED_IDIOM:?} in prose.\n'
  printf '#   * ${ANOTHER_ONE:?} indented, as the push overlay writes it.\n'
} >>"$tree/infra/rust/docker-compose.rust.yml"
sed -i.bak 's|^\(  api:\)$|\1\n    x-momo-test: ${AN_OPTIONAL_KNOB:-off}|' \
  "$tree/infra/rust/docker-compose.rust.yml"
rm -f "$tree/infra/rust/docker-compose.rust.yml.bak"
run_guard "$tree" --skip-docker
[ "$GUARD_STATUS" -eq 0 ] || fail "guard invented a requirement from a comment or a \${VAR:-default}
$GUARD_OUT"
pass "commented prose and \${VAR:-default} do not become requirements"

# =============================================================================
# Case 8 — #1781: `$${VAR:?}` is a container-shell requirement, not a compose
# interpolation. The huddle LiveKit entrypoint writes this form so operators
# who never select `--profile huddle` are not asked for secrets. A guard that
# cannot tell `$$` from `$` turns every rust rendering red on the documented
# empty template lines. Adding a new escaped requirement that no template
# fills must stay green; inventing a requirement here is the false alarm.
# =============================================================================
tree="$(new_tree escaped-shell-required)"
cat >>"$tree/infra/rust/docker-compose.rust.yml" <<'EOF'

x-momo-1781-escape-probe: ": $${A_SHELL_ONLY:?set A_SHELL_ONLY}"
EOF
run_guard "$tree" --skip-docker
[ "$GUARD_STATUS" -eq 0 ] || fail "guard treated \$\${VAR:?} as a compose requirement
$GUARD_OUT"
case "$GUARD_OUT" in
  *"A_SHELL_ONLY"*) fail "guard named the escaped shell key A_SHELL_ONLY
$GUARD_OUT" ;;
esac
pass "\$\${VAR:?} (compose-escaped shell required) does not become a template requirement"

# =============================================================================
# Case 9 — missing tool fails closed. A gate that turns itself off when its tool
# is absent is a gate that reports green on the day it matters (#1236).
# =============================================================================
mkdir -p "$SANDBOX_ROOT/nodocker"
cat >"$SANDBOX_ROOT/nodocker/docker" <<'EOF'
#!/bin/sh
exit 127
EOF
chmod +x "$SANDBOX_ROOT/nodocker/docker"
set +e
out="$(PATH="$SANDBOX_ROOT/nodocker:$PATH" "$GUARD" --root "$REPO_ROOT" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || fail "guard passed with docker compose unavailable: $out"
case "$out" in
  *"docker compose is unavailable"*) ;;
  *) fail "absent docker did not produce the documented message: $out" ;;
esac
pass "an absent docker compose fails the guard instead of silently reducing it"

# =============================================================================
# Case 10 — Coverage 3 inventories with git ls-files (#2328). gitignored
# stray files (.DS_Store) must stay green; deleting a tracked listed file
# is red; reverting the inventory to find makes .DS_Store red (the
# git ls-files swap is load-bearing).
# =============================================================================
init_git_fixture() {
  local dir="$1"
  (
    cd "$dir" || exit 1
    git init -q
    printf '%s\n' '.DS_Store' >.gitignore
    git add -A
    git -c user.email=compose-env-test@oort.invalid -c user.name=compose-env-test \
      commit -q -m init
  )
}

tree="$(new_tree coverage3-dsstore)"
init_git_fixture "$tree"
: >"$tree/infra/railway/.DS_Store"
run_guard "$tree" --skip-docker
[ "$GUARD_STATUS" -eq 0 ] || fail "gitignored .DS_Store turned Coverage 3 red
$GUARD_OUT"
pass "gitignored .DS_Store in a platform dir is green (git ls-files)"

tree="$(new_tree coverage3-deleted-tracked)"
init_git_fixture "$tree"
rm -f "$tree/infra/railway/README.md"
run_guard "$tree" --skip-docker
expect_red "deleted tracked platform file" "infra/railway/README.md"
pass "deleting a tracked listed platform file is red"

tree="$(new_tree coverage3-find-sabotage)"
init_git_fixture "$tree"
: >"$tree/infra/railway/.DS_Store"
guard_copy="$tree/check_compose_env_templates.sh"
# Revert the inventory to find -type f. .DS_Store must then turn red,
# proving git ls-files (not find) is what keeps the stray green.
awk '
  /ls-files --cached --others --exclude-standard/ {
    print "    find \"$" "dir\" -type f"
    next
  }
  { print }
' "$GUARD" >"$guard_copy"
chmod +x "$guard_copy"
set +e
GUARD_OUT="$("$guard_copy" --root "$tree" --skip-docker 2>&1)"
GUARD_STATUS=$?
set -e
expect_red "find inventory sees .DS_Store" "infra/railway/.DS_Store"
pass "sabotage Coverage 3 inventory back to find → .DS_Store RED"

echo "[compose-env-test] PASS: $CASES case(s)"
