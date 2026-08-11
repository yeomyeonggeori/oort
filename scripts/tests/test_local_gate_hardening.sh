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

# The canonical alignment preflight must be an unconditional consumer, not a
# helper reachable only from selected profiles. Keep exactly one top-level call
# before the profile switch; deleting or moving it turns this fixture red.
alignment_calls="$(grep -Ec '^add_track_alignment_preflight$' "$REPO_ROOT/scripts/local_gate.sh")"
[ "$alignment_calls" = 1 ] || fail "local gate must have exactly one unconditional alignment preflight"
alignment_line="$(grep -En '^add_track_alignment_preflight$' "$REPO_ROOT/scripts/local_gate.sh" | cut -d: -f1)"
profile_switch_line="$(awk -v start="$alignment_line" \
  'NR > start && /^case "\$PROFILE" in$/ { print NR; exit }' "$REPO_ROOT/scripts/local_gate.sh")"
[ "$alignment_line" -lt "$profile_switch_line" ] \
  || fail "alignment preflight must run before profile selection"
echo "[local-gate-hardening-test] PASS every profile consumes canonical alignment preflight"

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
positive_main_sha="$(git -C "$POSITIVE_REPO" rev-parse main)"
git -C "$POSITIVE_REMOTE" update-ref refs/heads/track/engine "$positive_main_sha"
git -C "$POSITIVE_REMOTE" update-ref refs/heads/track/uxui "$positive_main_sha"
git -C "$POSITIVE_REPO" config branch.main.remote origin
git -C "$POSITIVE_REPO" config branch.main.merge refs/heads/main
mkdir -p "$POSITIVE_REPO/scripts/hooks"
cp "$REPO_ROOT/scripts/check_branch_skew.sh" "$POSITIVE_REPO/scripts/"
cp "$REPO_ROOT/scripts/check_track_alignment.sh" "$POSITIVE_REPO/scripts/"
cp "$REPO_ROOT/scripts/hooks/pre-push" "$POSITIVE_REPO/scripts/hooks/"
feature_sha="$(git -C "$POSITIVE_REPO" rev-parse feature)"
if printf 'refs/heads/feature %s refs/heads/feature %040d\n' "$feature_sha" 0 | \
  (cd "$POSITIVE_REPO" && scripts/hooks/pre-push) >"$SANDBOX/pre-push.out" 2>&1; then
  fail "pre-push final consumer did not reject overlapping changes"
fi
grep -Fq 'shared.txt' "$SANDBOX/pre-push.out" || fail "pre-push failure omitted overlapping path"
if printf '(delete) %040d refs/heads/track/uxui %s\n' 0 "$positive_main_sha" | \
  (cd "$POSITIVE_REPO" && scripts/hooks/pre-push) >"$SANDBOX/pre-push-delete.out" 2>&1; then
  fail "pre-push allowed canonical branch deletion"
fi
grep -Fq 'deleting a canonical branch is blocked: refs/heads/track/uxui' \
  "$SANDBOX/pre-push-delete.out" || fail "pre-push deletion failure omitted canonical target"
if printf '(unknown) %s refs/heads/track/uxui %s\n' "$feature_sha" "$positive_main_sha" | \
  (cd "$POSITIVE_REPO" && scripts/hooks/pre-push) >"$SANDBOX/pre-push-unknown.out" 2>&1; then
  fail "pre-push allowed a stale canonical update sourced from a raw revision"
fi
grep -Fq 'not a fast-forward of origin/track/uxui' "$SANDBOX/pre-push-unknown.out" \
  || fail "pre-push raw-revision failure omitted the canonical fast-forward reason"
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

# ---- #1185: 스펙 YAML -> JSON 리더 선택 ------------------------------------
# 이 픽스처가 존재하는 이유는 red proof 를 영구화하기 위해서다. 게이트 14단계는
# 로그인 셸에서 /usr/bin/ruby 2.6 이 먼저 잡히면 빨갛고 직접 실주행은 초록이었다
# — psych 3 갈래가 2차 패스 사본에서 빠져 있었기 때문이다. 여기서는 `aliases:`
# 를 거부하는 가짜 ruby 를 PATH 앞에 세워 그 기계를 재현하고, ①변환이 여전히
# 성공하는지 ②**어느 갈래로 뛰었는지 실제로 출력하는지**를 함께 단정한다.
# 출력 단정이 없으면 조용한 강등이 초록으로 통과한다.
SPEC_LIB="$REPO_ROOT/scripts/openapi_spec_to_json.sh"
SPEC_SRC="$REPO_ROOT/docs/api/openapi.yaml"
test -f "$SPEC_LIB" || fail "spec->json 변환 정본이 없다: scripts/openapi_spec_to_json.sh"
test -f "$SPEC_SRC" || fail "docs/api/openapi.yaml 이 없다"

SPEC_SANDBOX="$SANDBOX/spec-reader"
mkdir -p "$SPEC_SANDBOX/fakebin"

# `aliases:` 를 쓰는 인자 조합만 거부하고 나머지는 실제 ruby 에 위임하는 shim.
# psych 3(= /usr/bin/ruby 2.6) 의 ArgumentError 와 같은 거절이다.
REAL_RUBY="$(command -v ruby 2>/dev/null || true)"
if [ -n "$REAL_RUBY" ]; then
  {
    printf '#!/usr/bin/env bash\n'
    printf 'for arg in "$@"; do\n'
    printf '  case "$arg" in\n'
    printf '    *aliases:*)\n'
    printf '      echo "unknown keyword: aliases (ArgumentError)" >&2\n'
    printf '      exit 1\n'
    printf '      ;;\n'
    printf '  esac\n'
    printf 'done\n'
    printf 'exec %s "$@"\n' "$REAL_RUBY"
  } >"$SPEC_SANDBOX/fakebin/ruby"
  chmod +x "$SPEC_SANDBOX/fakebin/ruby"

  # PyYAML 갈래가 대신 받아내서 초록을 만드는 일이 없도록 python 도 봉한다.
  # 이 픽스처가 증명해야 하는 것은 **ruby 갈래 안에서의 강등**이다.
  (
    PATH="$SPEC_SANDBOX/fakebin:$PATH"
    export PATH
    # shellcheck source=scripts/openapi_spec_to_json.sh
    . "$SPEC_LIB"
    momo_openapi_spec_to_json "$SPEC_SRC" "$SPEC_SANDBOX/out.json" openapi-test \
      "$SPEC_SANDBOX/fakebin/python-absent"
  ) >"$SPEC_SANDBOX/downgrade.out" 2>"$SPEC_SANDBOX/downgrade.err" \
    || fail "aliases: 를 거부하는 ruby 에서 변환이 실패했다 (#1185 회귀): $(cat "$SPEC_SANDBOX/downgrade.err")"

  grep -Fq 'spec->json reader:' "$SPEC_SANDBOX/downgrade.out" \
    || fail "리더 갈래를 한 줄도 출력하지 않았다 — 조용한 강등"
  grep -Fq 'psych 3-' "$SPEC_SANDBOX/downgrade.out" \
    || fail "psych 3 갈래로 뛰고도 그렇게 말하지 않았다: $(cat "$SPEC_SANDBOX/downgrade.out")"
  if command -v jq >/dev/null 2>&1; then
    jq -e '.openapi and .paths' "$SPEC_SANDBOX/out.json" >/dev/null \
      || fail "psych 3 갈래가 OpenAPI 문서를 만들지 못했다"
  fi

  # 같은 스펙에서 두 ruby 갈래가 같은 JSON 을 낸다 — 강등이 조용하지 않을 뿐
  # 아니라 결과도 동등하다는 단정. (실 ruby 가 psych 4+ 일 때만 의미가 있다.)
  if "$REAL_RUBY" -ryaml -e 'YAML.load("k: v", aliases: true)' >/dev/null 2>&1; then
    "$REAL_RUBY" -ryaml -rjson -e \
      'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))' \
      "$SPEC_SRC" >"$SPEC_SANDBOX/aliases.json"
    cmp -s "$SPEC_SANDBOX/aliases.json" "$SPEC_SANDBOX/out.json" \
      || fail "aliases: 갈래와 psych 3 갈래의 JSON 이 다르다"
  fi
  echo "[local-gate-hardening-test] PASS spec->json psych3 강등 갈래 + 갈래 고지 (#1185)"
else
  echo "[local-gate-hardening-test] SKIP spec->json ruby 강등 픽스처 (ruby 없음)"
fi

# 리더가 하나도 없으면 조용히 넘어가지 않고 갈래별 이유를 대고 죽는다.
# (PATH 를 비우는 대신 ruby 만 무력화한다 — PATH 를 비우면 rm/grep 이 사라져서
#  이 픽스처가 증명하려는 것과 다른 이유로 죽는다.)
{
  printf '#!/usr/bin/env bash\n'
  printf 'echo "no yaml for you" >&2\n'
  printf 'exit 1\n'
} >"$SPEC_SANDBOX/fakebin/ruby-dead"
chmod +x "$SPEC_SANDBOX/fakebin/ruby-dead"
mkdir -p "$SPEC_SANDBOX/deadbin"
cp "$SPEC_SANDBOX/fakebin/ruby-dead" "$SPEC_SANDBOX/deadbin/ruby"
(
  PATH="$SPEC_SANDBOX/deadbin:$PATH"
  export PATH
  # shellcheck source=scripts/openapi_spec_to_json.sh
  . "$SPEC_LIB"
  momo_openapi_spec_to_json "$SPEC_SRC" "$SPEC_SANDBOX/never.json" openapi-test python-absent
) >"$SPEC_SANDBOX/none.out" 2>"$SPEC_SANDBOX/none.err" \
  && fail "자격 있는 YAML 리더가 없는데 변환이 성공했다고 답했다"
grep -Fq 'no qualified YAML reader' "$SPEC_SANDBOX/none.err" \
  || fail "리더 부재를 이름 대고 죽지 않았다: $(cat "$SPEC_SANDBOX/none.err")"
grep -Fq 'ruby  :' "$SPEC_SANDBOX/none.err" || fail "ruby 갈래 실격 사유가 없다"
grep -Fq 'python:' "$SPEC_SANDBOX/none.err" || fail "python 갈래 실격 사유가 없다"
echo "[local-gate-hardening-test] PASS spec->json 리더 부재 정직한 실패 (#1185)"
