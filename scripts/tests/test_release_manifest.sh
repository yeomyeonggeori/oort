#!/usr/bin/env bash
# Isolated proofs for SH-1 / #1954 (releases/latest.json drift gate).
#
# Green on a healthy tree is not evidence. Every RED case below names the
# mutation. Nothing here writes inside the repository: each case mutates a copy.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check_release_manifest.sh"
SANDBOX_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oort-release-manifest-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX_ROOT"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

[ -x "$GUARD" ] || chmod +x "$GUARD"

CASES=0
fail() { echo "[release-manifest-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[release-manifest-test] ok: $*"; }

need_jq() {
  command -v jq >/dev/null 2>&1 || fail "jq is required"
}
need_jq

HEX0="$(printf '%064d' 0)"
HEX1="$(printf '%064d' 1)"
HEX2="$(printf '%064d' 2)"
HEX3="$(printf '%064d' 3)"
HEX4="$(printf '%064d' 4)"
HEX5="$(printf '%064d' 5)"

write_manifest() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cat >"$dest" <<EOF
{
  "version": "v0.1.4",
  "released_at": "2026-09-02",
  "images": {
    "app": {
      "ref": "ghcr.io/yeomyeonggeori/oort",
      "digest_list": "sha256:${HEX0}",
      "digests": {
        "amd64": "sha256:${HEX1}",
        "arm64": "sha256:${HEX2}"
      }
    },
    "postgres": {
      "ref": "ghcr.io/yeomyeonggeori/oort-postgres",
      "digest_list": "sha256:${HEX3}",
      "digests": {
        "amd64": "sha256:${HEX4}",
        "arm64": "sha256:${HEX5}"
      }
    }
  },
  "attestation": {
    "verify_cmd": "gh attestation verify \"oci://ghcr.io/yeomyeonggeori/oort@sha256:${HEX0}\" --repo yeomyeonggeori/oort --predicate-type https://slsa.dev/provenance/v1"
  },
  "sources": {
    "release_url": "https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.4"
  }
}
EOF
}

new_tree() {
  local dir="$SANDBOX_ROOT/$1"
  rm -rf "$dir"
  mkdir -p "$dir/docs" "$dir/releases"
  cat >"$dir/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

## [0.1.4] - 2026-09-02

### Added
- fixture

## [0.1.0] - 2026-08-21
EOF
  printf '# self host\n\nclone then run the env script.\n' >"$dir/docs/SELF_HOST.md"
  printf '# agent playbook\n\nno digest literals here.\n' >"$dir/docs/SELF_HOST_AGENT.md"
  printf '# oort\n\n## Self-host\n\nSee docs/SELF_HOST.md.\n' >"$dir/README.md"
  write_manifest "$dir/releases/latest.json"
  echo "$dir"
}

run_guard() {
  local root="$1"
  shift
  set +e
  GUARD_OUT="$("$GUARD" --root "$root" "$@" 2>&1)"
  GUARD_STATUS=$?
  set -e
}

expect_red() {
  local what="$1"
  local needle="$2"
  [ "$GUARD_STATUS" -ne 0 ] || fail "$what: guard stayed green
$GUARD_OUT"
  case "$GUARD_OUT" in
    *"$needle"*) ;;
    *)
      fail "$what: red, but never named '$needle'
$GUARD_OUT"
      ;;
  esac
}

expect_green() {
  local what="$1"
  [ "$GUARD_STATUS" -eq 0 ] || fail "$what: guard is red
$GUARD_OUT"
}

# -----------------------------------------------------------------------------
# Pass — valid fixture, clean docs, CHANGELOG 0.1.4
# -----------------------------------------------------------------------------
tree="$(new_tree pass)"
run_guard "$tree"
expect_green "pass fixture"
pass "green on a valid fixture (schema + docs + CHANGELOG)"

# -----------------------------------------------------------------------------
# RED — one-character digest mutation (last hex of app list → 'g')
# -----------------------------------------------------------------------------
tree="$(new_tree digest-one-char)"
mutated="$(jq -r '.images.app.digest_list' "$tree/releases/latest.json")"
mutated="${mutated%?}g"
jq --arg d "$mutated" '.images.app.digest_list = $d' \
  "$tree/releases/latest.json" >"$tree/releases/latest.json.tmp"
mv "$tree/releases/latest.json.tmp" "$tree/releases/latest.json"
run_guard "$tree"
expect_red "digest one-char" "does not match"
pass "RED: one-character digest mutation fails the regex"

# -----------------------------------------------------------------------------
# RED — leftover @sha256: literal in docs/SELF_HOST.md
# -----------------------------------------------------------------------------
tree="$(new_tree leftover-sha)"
printf '\npin example: ghcr.io/yeomyeonggeori/oort@sha256:%s\n' "$HEX0" \
  >>"$tree/docs/SELF_HOST.md"
run_guard "$tree"
expect_red "leftover @sha256:" "@sha256:"
pass "RED: leftover @sha256: literal in docs/SELF_HOST.md"

# -----------------------------------------------------------------------------
# RED — leftover @sha256: in README.md (same rule)
# -----------------------------------------------------------------------------
tree="$(new_tree leftover-readme)"
printf '\n@sha256: leftover\n' >>"$tree/README.md"
run_guard "$tree"
expect_red "leftover README" "@sha256:"
pass "RED: leftover @sha256: literal in README.md"

# -----------------------------------------------------------------------------
# RED — version mismatch vs CHANGELOG newest
# -----------------------------------------------------------------------------
tree="$(new_tree version-mismatch)"
jq '.version = "v0.1.3"' "$tree/releases/latest.json" \
  >"$tree/releases/latest.json.tmp"
mv "$tree/releases/latest.json.tmp" "$tree/releases/latest.json"
# verify_cmd still mentions HEX0; schema only requires the list digest substring.
run_guard "$tree"
expect_red "version mismatch" "CHANGELOG"
pass "RED: manifest version != CHANGELOG newest"

# -----------------------------------------------------------------------------
# RED — list digest equal to an arch digest
# -----------------------------------------------------------------------------
tree="$(new_tree list-eq-arch)"
jq --arg d "sha256:${HEX1}" '.images.app.digest_list = $d' \
  "$tree/releases/latest.json" >"$tree/releases/latest.json.tmp"
mv "$tree/releases/latest.json.tmp" "$tree/releases/latest.json"
# keep verify_cmd in sync so this case names the uniqueness failure, not verify_cmd.
jq --arg d "sha256:${HEX1}" \
  '.attestation.verify_cmd = ("gh attestation verify \"oci://ghcr.io/yeomyeonggeori/oort@" + $d + "\" --repo yeomyeonggeori/oort --predicate-type https://slsa.dev/provenance/v1")' \
  "$tree/releases/latest.json" >"$tree/releases/latest.json.tmp"
mv "$tree/releases/latest.json.tmp" "$tree/releases/latest.json"
run_guard "$tree"
expect_red "list equals arch" "equals amd64"
pass "RED: list digest equal to amd64 digest"

# -----------------------------------------------------------------------------
# Optional: committed tree is green once latest.json exists.
# -----------------------------------------------------------------------------
if [ -f "$REPO_ROOT/releases/latest.json" ]; then
  run_guard "$REPO_ROOT"
  expect_green "committed tree"
  pass "green on the committed releases/latest.json"
else
  echo "[release-manifest-test] skip: committed releases/latest.json not present (RED tree)"
fi

echo "[release-manifest-test] $CASES case(s) passed"
