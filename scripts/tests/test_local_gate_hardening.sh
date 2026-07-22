#!/usr/bin/env bash
# MOMO-555 isolated positive/negative fixtures. No network, Docker, or DB.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-local-gate-hardening.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT INT TERM

fail() {
  echo "[local-gate-hardening-test] FAIL: $*" >&2
  exit 1
}

init_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Momo Gate Test"
  git -C "$repo" config user.email "gate-test@momo.invalid"
  printf 'base\n' >"$repo/shared.txt"
  git -C "$repo" add shared.txt
  git -C "$repo" commit -qm base
  git -C "$repo" branch -M main
}

# Negative skew fixture: upstream and feature touch disjoint files.
NEGATIVE_REPO="$SANDBOX/skew-negative"
init_repo "$NEGATIVE_REPO"
git -C "$NEGATIVE_REPO" checkout -qb feature
printf 'feature\n' >"$NEGATIVE_REPO/feature.txt"
git -C "$NEGATIVE_REPO" add feature.txt
git -C "$NEGATIVE_REPO" commit -qm feature
git -C "$NEGATIVE_REPO" checkout -q main
printf 'upstream\n' >"$NEGATIVE_REPO/upstream.txt"
git -C "$NEGATIVE_REPO" add upstream.txt
git -C "$NEGATIVE_REPO" commit -qm upstream
git -C "$NEGATIVE_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$NEGATIVE_REPO" checkout -q feature
(cd "$NEGATIVE_REPO" && "$REPO_ROOT/scripts/check_branch_skew.sh") >/dev/null \
  || fail "disjoint upstream/feature changes were rejected"

# Positive skew fixture: both sides modify the same path after merge-base.
POSITIVE_REPO="$SANDBOX/skew-positive"
init_repo "$POSITIVE_REPO"
git -C "$POSITIVE_REPO" checkout -qb feature
printf 'feature edit\n' >"$POSITIVE_REPO/shared.txt"
git -C "$POSITIVE_REPO" commit -qam feature
git -C "$POSITIVE_REPO" checkout -q main
printf 'upstream edit\n' >"$POSITIVE_REPO/shared.txt"
git -C "$POSITIVE_REPO" commit -qam upstream
git -C "$POSITIVE_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$POSITIVE_REPO" checkout -q feature
if (cd "$POSITIVE_REPO" && "$REPO_ROOT/scripts/check_branch_skew.sh") >"$SANDBOX/skew.out" 2>&1; then
  fail "overlapping upstream/feature change did not fail"
fi
grep -Fq 'shared.txt' "$SANDBOX/skew.out" || fail "skew failure omitted overlapping path"
(cd "$POSITIVE_REPO" && MOMO_GATE_SKIP_SKEW='fixture reviewed exception' "$REPO_ROOT/scripts/check_branch_skew.sh") >/dev/null \
  || fail "reasoned skew override was rejected"

# Exercise the optional hook as a final consumer, with a local bare remote so
# the hook's fail-closed fetch is part of the fixture too.
POSITIVE_REMOTE="$SANDBOX/skew-positive-origin.git"
git clone -q --bare "$POSITIVE_REPO" "$POSITIVE_REMOTE"
git -C "$POSITIVE_REPO" remote add origin "$POSITIVE_REMOTE"
mkdir -p "$POSITIVE_REPO/scripts/hooks"
cp "$REPO_ROOT/scripts/check_branch_skew.sh" "$POSITIVE_REPO/scripts/"
cp "$REPO_ROOT/scripts/hooks/pre-push" "$POSITIVE_REPO/scripts/hooks/"
feature_sha="$(git -C "$POSITIVE_REPO" rev-parse feature)"
if printf 'refs/heads/feature %s refs/heads/feature %040d\n' "$feature_sha" 0 | \
  (cd "$POSITIVE_REPO" && scripts/hooks/pre-push) >"$SANDBOX/pre-push.out" 2>&1; then
  fail "pre-push final consumer did not reject overlapping changes"
fi
grep -Fq 'shared.txt' "$SANDBOX/pre-push.out" || fail "pre-push failure omitted overlapping path"
echo "[local-gate-hardening-test] PASS branch-skew helper/hook negative/positive/override fixtures"

# Migration number negative/positive fixtures, including 37 vs 037 normalization.
MIGRATIONS="$SANDBOX/migrations"
mkdir -p "$MIGRATIONS"
: >"$MIGRATIONS/036_existing.sql"
: >"$MIGRATIONS/037_one.sql"
"$REPO_ROOT/scripts/check_migration_numbers.sh" "$MIGRATIONS" >/dev/null \
  || fail "unique migration prefixes were rejected"
: >"$MIGRATIONS/37_two.sql"
if "$REPO_ROOT/scripts/check_migration_numbers.sh" "$MIGRATIONS" >"$SANDBOX/migrations.out" 2>&1; then
  fail "duplicate normalized migration prefix did not fail"
fi
grep -Fq '037_one.sql' "$SANDBOX/migrations.out" || fail "duplicate report omitted first file"
grep -Fq '37_two.sql' "$SANDBOX/migrations.out" || fail "duplicate report omitted second file"

# Exercise migrate.sh itself: the collision must win before psql discovery.
MIGRATE_FIXTURE="$SANDBOX/migrate-final-consumer"
mkdir -p "$MIGRATE_FIXTURE/scripts" "$MIGRATE_FIXTURE/server/Migrations"
cp "$REPO_ROOT/scripts/migrate.sh" "$REPO_ROOT/scripts/check_migration_numbers.sh" "$MIGRATE_FIXTURE/scripts/"
cp "$MIGRATIONS/037_one.sql" "$MIGRATIONS/37_two.sql" "$MIGRATE_FIXTURE/server/Migrations/"
if "$MIGRATE_FIXTURE/scripts/migrate.sh" >"$SANDBOX/migrate.out" 2>&1; then
  fail "migrate.sh final consumer did not reject duplicate migration numbers"
fi
grep -Fq 'duplicate migration number prefix' "$SANDBOX/migrate.out" \
  || fail "migrate.sh did not fail at the migration-number preflight"
echo "[local-gate-hardening-test] PASS migration helper/migrate final-consumer fixtures"

# Manifest is produced from final artifacts and detects later tampering.
ARTIFACTS="$SANDBOX/artifacts"
mkdir -p "$ARTIFACTS/nested"
printf 'evidence\n' >"$ARTIFACTS/evidence.md"
printf 'log\n' >"$ARTIFACTS/nested/gate.log"
MANIFEST="$SANDBOX/SHA256SUMS"
"$REPO_ROOT/scripts/write_sha256_manifest.sh" "$MANIFEST" "$ARTIFACTS" >/dev/null
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c "$MANIFEST" >/dev/null || fail "fresh manifest did not verify"
else
  sha256sum -c "$MANIFEST" >/dev/null || fail "fresh manifest did not verify"
fi
printf 'tampered\n' >>"$ARTIFACTS/evidence.md"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c "$MANIFEST" >/dev/null 2>&1 && fail "tampered artifact still verified"
else
  sha256sum -c "$MANIFEST" >/dev/null 2>&1 && fail "tampered artifact still verified"
fi
echo "[local-gate-hardening-test] PASS sha256 manifest generation/tamper fixture"
