#!/usr/bin/env bash
# Red proofs for scripts/check_dockerfile_crates.sh (#3876).
#
# A guard that is green on a healthy tree has proved nothing — a guard that
# always exits 0 is green too. Every case below either turns the guard RED for a
# named reason (the exit status AND the offending crate/line in the output), or
# shows it staying GREEN where red would be a false alarm. Nothing writes inside
# the repository: each case mutates a copy under a mktemp sandbox, and a
# mutation that silently changes nothing fails the test instead of passing it.
#
# Four layers:
#   1. the live tree (green, with a count taken independently of the guard)
#   2. the #3876 / #3837 shape on the REAL Dockerfile bytes: delete one COPY
#      line, add a crate, restore -> green
#   3. the parser's edges: comments, --from, destinations, stale lines, CRLF,
#      workspace shapes the guard must refuse to guess about, and fail-closed
#   4. the wiring: the real scripts/check_ghcr_notice_bundle.sh (the unprotected
#      script PR CI's `alignment` job already runs on every PR) really runs the
#      guard, and still reports the notice check's own failures
# plus, when the history is present, a replay of the Dockerfile that actually
# broke the v0.1.27 publish.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check_dockerfile_crates.sh"
WRAPPER="$REPO_ROOT/scripts/check_ghcr_notice_bundle.sh"
SANDBOX_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-dockerfile-crates-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX_ROOT"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[dockerfile-crates-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[dockerfile-crates-test] ok: $*"; }

[ -f "$GUARD" ] || fail "missing $GUARD"
[ -x "$GUARD" ] || fail "$GUARD lost its executable bit (docs name it as a command; check_docs_commands.py requires +x)"
bash -n "$GUARD" || fail "bash -n $GUARD"
bash -n "$WRAPPER" || fail "bash -n $WRAPPER"

OUT=""
STATUS=0

# Runs the guard and records its combined output; never aborts the harness.
run_guard() {
  local root="$1"
  shift
  set +e
  OUT="$(bash "$GUARD" --root "$root" "$@" 2>&1)"
  STATUS=$?
  set -e
}

expect_green() {
  local what="$1"
  [ "$STATUS" -eq 0 ] || fail "$what: expected green, got exit $STATUS
$OUT"
  case "$OUT" in
    *"PASS:"*) ;;
    *) fail "$what: exit 0 but no PASS line
$OUT" ;;
  esac
}

# expect_exit WHAT STATUS NEEDLE... — the exit status AND every needle in the output.
expect_exit() {
  local what="$1" want="$2" needle
  shift 2
  [ "$STATUS" -eq "$want" ] || fail "$what: expected exit $want, got $STATUS
$OUT"
  for needle in "$@"; do
    case "$OUT" in
      *"$needle"*) ;;
      *) fail "$what: red, but the output never says '$needle'
$OUT" ;;
    esac
  done
}

expect_absent() {
  local what="$1" needle="$2"
  case "$OUT" in
    *"$needle"*) fail "$what: output must NOT contain '$needle'
$OUT" ;;
  esac
}

# A tree shaped like the repository: the REAL workspace manifest and the REAL
# Dockerfile bytes, plus an empty Cargo.toml for every real crate/bin (the guard
# only asks whether a manifest exists). Prints the tree root.
real_tree() {
  local dir="$SANDBOX_ROOT/$1" m rel
  rm -rf "$dir"
  mkdir -p "$dir/server-rust"
  cp "$REPO_ROOT/server-rust/Cargo.toml" "$REPO_ROOT/server-rust/Dockerfile" "$dir/server-rust/"
  for m in "$REPO_ROOT"/server-rust/crates/*/Cargo.toml "$REPO_ROOT"/server-rust/bins/*/Cargo.toml; do
    rel="${m#"$REPO_ROOT"/}"
    mkdir -p "$dir/$(dirname "$rel")"
    : >"$dir/$rel"
  done
  echo "$dir"
}

# A three-member synthetic workspace (alpha, beta-two, gamma) with a Dockerfile
# in the canonical shape. Prints the tree root.
mini_tree() {
  local dir="$SANDBOX_ROOT/$1" m
  rm -rf "$dir"
  mkdir -p "$dir/server-rust/crates/alpha" "$dir/server-rust/crates/beta-two" "$dir/server-rust/bins/gamma"
  for m in crates/alpha crates/beta-two bins/gamma; do
    : >"$dir/server-rust/$m/Cargo.toml"
  done
  cat >"$dir/server-rust/Cargo.toml" <<'EOF'
[workspace]
resolver = "2"
members = ["crates/*", "bins/*"]

[workspace.package]
edition = "2021"
EOF
  cat >"$dir/server-rust/Dockerfile" <<'EOF'
FROM rust:1 AS build
WORKDIR /src/server-rust
COPY server-rust/Cargo.toml server-rust/Cargo.lock ./
COPY server-rust/crates/alpha/Cargo.toml crates/alpha/
COPY server-rust/crates/beta-two/Cargo.toml crates/beta-two/
COPY server-rust/bins/gamma/Cargo.toml bins/gamma/
RUN cargo build --release
COPY server-rust/crates crates
COPY server-rust/bins bins
EOF
  echo "$dir"
}

# edit_df TREE SED-SCRIPT — rewrite TREE's Dockerfile with sed and insist the
# bytes changed, so a mutation that matched nothing cannot pass as a red proof.
edit_df() {
  local f="$1/server-rust/Dockerfile"
  cp "$f" "$f.before"
  sed "$2" "$f.before" >"$f"
  if cmp -s "$f.before" "$f"; then
    fail "fixture edit changed nothing: sed '$2'"
  fi
  rm -f "$f.before"
}

# insert_after TREE PREFIX NEWLINE — add NEWLINE after the first Dockerfile line
# that starts with PREFIX; fails when no line does.
insert_after() {
  local f="$1/server-rust/Dockerfile" prefix="$2" new="$3" line placed=0
  cp "$f" "$f.before"
  : >"$f"
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >>"$f"
    if [ "$placed" -eq 0 ] && [ "${line#"$prefix"}" != "$line" ]; then
      printf '%s\n' "$new" >>"$f"
      placed=1
    fi
  done <"$f.before"
  [ "$placed" -eq 1 ] || fail "fixture drift: no Dockerfile line starts with '$prefix'"
  rm -f "$f.before"
}

count_manifests() {
  local n=0 m
  for m in "$REPO_ROOT"/server-rust/"$1"/*/Cargo.toml; do
    if [ -f "$m" ]; then n=$((n + 1)); fi
  done
  echo "$n"
}

# --- victims on the real tree, chosen from it so the test outlives any rename --
# member_at KIND first|last — the name of the first/last KIND/* directory that
# holds a Cargo.toml (bash glob order; no `ls | head`, which SIGPIPEs under pipefail).
member_at() {
  local d name pick=""
  for d in "$REPO_ROOT"/server-rust/"$1"/*/; do
    [ -f "${d}Cargo.toml" ] || continue
    name="${d%/}"
    name="${name##*/}"
    if [ "$2" = first ]; then
      echo "$name"
      return 0
    fi
    pick="$name"
  done
  echo "$pick"
}
V_CRATE_FIRST="$(member_at crates first)"
V_CRATE_LAST="$(member_at crates last)"
V_BIN_LAST="$(member_at bins last)"
[ -n "$V_CRATE_FIRST" ] && [ -n "$V_CRATE_LAST" ] && [ -n "$V_BIN_LAST" ] ||
  fail "the live tree has no crates/bins to mutate"

# =============================================================================
# Layer 1 — the live tree.
# =============================================================================
N_CRATES="$(count_manifests crates)"
N_BINS="$(count_manifests bins)"
run_guard "$REPO_ROOT"
expect_green "live tree"
expect_exit "live tree count" 0 "all $((N_CRATES + N_BINS)) workspace members ($N_CRATES crates + $N_BINS bins)"
pass "the live tree is green, and the guard saw $N_CRATES crates + $N_BINS bins — the count taken here without it"

tree="$(mini_tree mini-green)"
run_guard "$tree"
expect_green "synthetic tree"
expect_exit "synthetic count" 0 "all 3 workspace members (2 crates + 1 bins)"
pass "a synthetic three-member workspace is green"

run_guard "$tree" --help
expect_exit "--help" 0 "Usage: scripts/check_dockerfile_crates.sh"
run_guard "$tree" --no-such-flag
expect_exit "unknown flag" 2 "unknown argument: --no-such-flag"
pass "--help exits 0 and an unknown flag exits 2"

# =============================================================================
# Layer 2 — the #3876 shape on the real Dockerfile bytes.
# =============================================================================
tree="$(real_tree real-baseline)"
run_guard "$tree"
expect_green "real-shape baseline"
pass "real Cargo.toml + real Dockerfile + stub manifests is green (the fixtures are faithful)"

tree="$(real_tree drop-crate-copy)"
edit_df "$tree" "\\|^COPY server-rust/crates/${V_CRATE_LAST}/Cargo.toml |d"
run_guard "$tree"
expect_exit "#3876: crate COPY deleted" 1 \
  "crates/${V_CRATE_LAST}" \
  "add:  COPY server-rust/crates/${V_CRATE_LAST}/Cargo.toml crates/${V_CRATE_LAST}/" \
  "failed to read /src/server-rust/"
pass "deleting the COPY line of crates/${V_CRATE_LAST} is red and prints the exact line to add — the v0.1.27 failure"
cp "$REPO_ROOT/server-rust/Dockerfile" "$tree/server-rust/Dockerfile"
run_guard "$tree"
expect_green "restored Dockerfile"
pass "restoring that line turns the same tree green"

tree="$(real_tree drop-bin-copy)"
edit_df "$tree" "\\|^COPY server-rust/bins/${V_BIN_LAST}/Cargo.toml |d"
run_guard "$tree"
expect_exit "bin COPY deleted" 1 "bins/${V_BIN_LAST}" "add:  COPY server-rust/bins/${V_BIN_LAST}/Cargo.toml bins/${V_BIN_LAST}/"
pass "a bin is held to the same rule as a crate"

tree="$(real_tree extra-members)"
mkdir -p "$tree/server-rust/crates/momo-newcrate" "$tree/server-rust/bins/momo-newbin"
: >"$tree/server-rust/crates/momo-newcrate/Cargo.toml"
: >"$tree/server-rust/bins/momo-newbin/Cargo.toml"
run_guard "$tree"
expect_exit "new crate and bin, no COPY" 1 \
  "crates/momo-newcrate" "add:  COPY server-rust/crates/momo-newcrate/Cargo.toml crates/momo-newcrate/" \
  "bins/momo-newbin" "add:  COPY server-rust/bins/momo-newbin/Cargo.toml bins/momo-newbin/"
pass "adding a crate and a bin without touching the Dockerfile is red, and both are named in one run"
rm -rf "$tree/server-rust/crates/momo-newcrate" "$tree/server-rust/bins/momo-newbin"
run_guard "$tree"
expect_green "extra members removed"
pass "removing them again turns the tree green"

# =============================================================================
# Layer 3 — the parser's edges.
# =============================================================================
tree="$(real_tree stale-no-such-crate)"
insert_after "$tree" "COPY server-rust/bins/${V_BIN_LAST}/Cargo.toml " \
  "COPY server-rust/crates/momo-gone/Cargo.toml crates/momo-gone/"
run_guard "$tree"
expect_exit "stale COPY, crate never existed" 1 "stale" "server-rust/crates/momo-gone/Cargo.toml" "server-rust/Dockerfile:"
pass "a COPY line for a crate that does not exist is red, with its Dockerfile line number"

tree="$(real_tree stale-crate-deleted)"
rm -rf "$tree/server-rust/crates/${V_CRATE_FIRST}"
run_guard "$tree"
expect_exit "stale COPY, crate deleted" 1 "stale" "server-rust/crates/${V_CRATE_FIRST}/Cargo.toml"
expect_absent "deleted crate is not also 'missing'" "add:  COPY server-rust/crates/${V_CRATE_FIRST}/"
pass "deleting a crate but leaving its COPY line is red as stale (not as missing)"

tree="$(real_tree wrong-destination)"
edit_df "$tree" "s|^\\(COPY server-rust/crates/${V_CRATE_FIRST}/Cargo\\.toml \\)crates/${V_CRATE_FIRST}/\$|\\1crates/${V_CRATE_FIRST}-typo/|"
run_guard "$tree"
expect_exit "destination typo" 1 "wrong destination" "crates/${V_CRATE_FIRST}-typo/" "expected: crates/${V_CRATE_FIRST}/"
pass "a manifest copied into the wrong directory is red"

tree="$(real_tree destination-without-slash)"
edit_df "$tree" "s|^\\(COPY server-rust/crates/${V_CRATE_FIRST}/Cargo\\.toml crates/${V_CRATE_FIRST}\\)/\$|\\1|"
run_guard "$tree"
expect_exit "destination without trailing slash" 1 "wrong destination" "expected: crates/${V_CRATE_FIRST}/"
pass "a destination without the trailing slash (a file, not a directory) is red"

tree="$(real_tree commented-out)"
edit_df "$tree" "s|^COPY server-rust/crates/${V_CRATE_LAST}/|# COPY server-rust/crates/${V_CRATE_LAST}/|"
run_guard "$tree"
expect_exit "commented-out COPY" 1 "crates/${V_CRATE_LAST}" "add:  COPY"
pass "a commented-out COPY line does not count as present"

tree="$(real_tree from-stage)"
edit_df "$tree" "s|^COPY server-rust/crates/${V_CRATE_LAST}/|COPY --from=build server-rust/crates/${V_CRATE_LAST}/|"
run_guard "$tree"
expect_exit "COPY --from" 1 "crates/${V_CRATE_LAST}" "add:  COPY"
pass "a COPY --from=<stage> line does not count as present"

tree="$(real_tree one-run-everything)"
edit_df "$tree" "\\|^COPY server-rust/crates/${V_CRATE_LAST}/Cargo.toml |d"
edit_df "$tree" "\\|^COPY server-rust/bins/${V_BIN_LAST}/Cargo.toml |d"
insert_after "$tree" "COPY server-rust/crates/${V_CRATE_FIRST}/Cargo.toml " \
  "COPY server-rust/crates/momo-gone/Cargo.toml crates/momo-gone/"
run_guard "$tree"
expect_exit "everything wrong at once" 1 \
  "crates/${V_CRATE_LAST}" "bins/${V_BIN_LAST}" "server-rust/crates/momo-gone/Cargo.toml"
pass "two missing members and one stale line are all reported in a single run"

tree="$(real_tree leftover-dir)"
mkdir -p "$tree/server-rust/crates/leftover/target" "$tree/server-rust/bins/empty"
: >"$tree/server-rust/crates/leftover/target/debris"
run_guard "$tree"
expect_green "directories without a Cargo.toml"
pass "a directory without a Cargo.toml (build debris after a branch switch) is not a member — no false alarm"

tree="$(real_tree crlf)"
sed $'s/$/\r/' "$tree/server-rust/Dockerfile" >"$tree/server-rust/Dockerfile.crlf"
mv "$tree/server-rust/Dockerfile.crlf" "$tree/server-rust/Dockerfile"
sed $'s/$/\r/' "$tree/server-rust/Cargo.toml" >"$tree/server-rust/Cargo.toml.crlf"
mv "$tree/server-rust/Cargo.toml.crlf" "$tree/server-rust/Cargo.toml"
run_guard "$tree"
expect_green "CRLF line endings"
pass "CRLF line endings in the Dockerfile and Cargo.toml are read correctly"

tree="$(mini_tree members-multiline)"
cat >"$tree/server-rust/Cargo.toml" <<'EOF'
[package.metadata.decoy]
members = ["tools/*"]

[workspace]
resolver = "2"
members = [
  # first-party libraries
  "crates/*",   # trailing comment
  'bins/*',
]

[workspace.dependencies]
members = ["not/read/either"]
EOF
run_guard "$tree"
expect_green "multi-line members"
pass "a multi-line members array with comments and single quotes is read; a 'members' key in another table is ignored"

tree="$(mini_tree members-new-root)"
sed 's|^members = .*|members = ["crates/*", "bins/*", "tools/*"]|' "$tree/server-rust/Cargo.toml" >"$tree/server-rust/Cargo.toml.new"
mv "$tree/server-rust/Cargo.toml.new" "$tree/server-rust/Cargo.toml"
run_guard "$tree"
expect_exit "unmodelled member root" 2 "tools/*" "extend"
pass "a workspace member root the guard does not model is exit 2, not a silent pass"

tree="$(mini_tree workspace-exclude)"
cat >"$tree/server-rust/Cargo.toml" <<'EOF'
[workspace]
resolver = "2"
members = ["crates/*", "bins/*"]
exclude = ["crates/alpha"]
EOF
run_guard "$tree"
expect_exit "workspace exclude" 2 "exclude"
pass "a [workspace] exclude list is exit 2 (not modelled), not a guess"

tree="$(mini_tree members-absent)"
printf '[workspace]\nresolver = "2"\n' >"$tree/server-rust/Cargo.toml"
run_guard "$tree"
expect_exit "no members array" 2 "no [workspace] members array"
pass "a manifest without a members array is exit 2"

# --- fail-closed: nothing to compare is never a pass --------------------------
tree="$(mini_tree no-members-on-disk)"
rm -rf "$tree/server-rust/crates" "$tree/server-rust/bins"
run_guard "$tree"
expect_exit "no members on disk" 2 "refusing to pass vacuously"
pass "a workspace with no member manifests is exit 2, never a vacuous pass"

tree="$(mini_tree parser-drift)"
printf 'FROM rust:1 AS build\nCOPY server-rust/crates crates\nCOPY server-rust/bins bins\n' >"$tree/server-rust/Dockerfile"
run_guard "$tree"
expect_exit "no manifest COPY line parsed" 2 "could be parsed"
pass "a Dockerfile with no parsable manifest COPY line is exit 2 (restructured, or the parser drifted)"

tree="$(mini_tree no-dockerfile)"
rm -f "$tree/server-rust/Dockerfile"
run_guard "$tree"
expect_exit "missing Dockerfile" 2 "missing Dockerfile"
tree="$(mini_tree no-cargo-toml)"
rm -f "$tree/server-rust/Cargo.toml"
run_guard "$tree"
expect_exit "missing Cargo.toml" 2 "missing workspace manifest"
run_guard "$SANDBOX_ROOT/does-not-exist"
expect_exit "bad --root" 2 "--root is not a directory"
pass "a missing Dockerfile, a missing Cargo.toml and a bad --root are all exit 2"

# =============================================================================
# Layer 4 — the wiring: the real PR-CI-invoked script runs the guard.
#
# scripts/check_ghcr_notice_bundle.sh is copied byte-for-byte next to the guard
# in a sandbox repository whose python generator is a recording stub, so this
# proves the wrapper's own behaviour without needing the notice bundle.
# =============================================================================
wrap_tree() {
  local dir
  dir="$(mini_tree "$1")"
  mkdir -p "$dir/scripts"
  cp "$WRAPPER" "$dir/scripts/check_ghcr_notice_bundle.sh"
  cp "$GUARD" "$dir/scripts/check_dockerfile_crates.sh"
  cat >"$dir/scripts/generate_ghcr_notice_bundle.py" <<'PY'
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "python-argv.txt"), "w") as fh:
    fh.write(" ".join(sys.argv[1:]) + "\n")
sys.exit(int(os.environ.get("STUB_PY_RC", "0")))
PY
  echo "$dir"
}

# run_wrapper DIR [ARGS...] — STUB_PY_RC is passed through from the caller.
run_wrapper() {
  local dir="$1"
  shift
  rm -f "$dir/scripts/python-argv.txt"
  set +e
  OUT="$(bash "$dir/scripts/check_ghcr_notice_bundle.sh" "$@" 2>&1)"
  STATUS=$?
  set -e
}

python_argv() {
  [ -f "$1/scripts/python-argv.txt" ] || fail "the notice generator was never invoked"
  tr -d '\n' <"$1/scripts/python-argv.txt"
}

wrap="$(wrap_tree wrapper-in-sync)"
run_wrapper "$wrap" --stale-only
expect_exit "wrapper, tree in sync" 0 "[dockerfile-crates] PASS:"
[ "$(python_argv "$wrap")" = "check --stale-only" ] || fail "wrapper did not hand '--stale-only' through to the notice generator: $(python_argv "$wrap")"
pass "check_ghcr_notice_bundle.sh --stale-only (the exact PR CI command) runs the guard and still hands its arguments to the notice check"

wrap="$(wrap_tree wrapper-drift)"
edit_df "$wrap" "\\|^COPY server-rust/bins/gamma/Cargo.toml |d"
run_wrapper "$wrap" --stale-only
expect_exit "wrapper, COPY line deleted" 1 "bins/gamma" "add:  COPY server-rust/bins/gamma/Cargo.toml bins/gamma/"
[ "$(python_argv "$wrap")" = "check --stale-only" ] || fail "the notice check must still run when the crate guard is red"
pass "a drifted Dockerfile turns the PR-CI-invoked script red, and the notice check still runs and reports"

wrap="$(wrap_tree wrapper-notice-red)"
set +e
OUT="$(STUB_PY_RC=3 bash "$wrap/scripts/check_ghcr_notice_bundle.sh" --stale-only 2>&1)"
STATUS=$?
set -e
expect_exit "wrapper, notice generator red" 3 "[dockerfile-crates] PASS:"
pass "the notice check's own failure is not masked by a green crate guard (exit 3 passes through)"

wrap="$(wrap_tree wrapper-other-tree)"
edit_df "$wrap" "\\|^COPY server-rust/bins/gamma/Cargo.toml |d"
run_wrapper "$wrap" --repo-root "$SANDBOX_ROOT/elsewhere" --stale-only
expect_exit "wrapper, notice check aimed at another tree" 0 "[dockerfile-crates] skipped"
expect_absent "the skip must not run the guard" "bins/gamma"
[ "$(python_argv "$wrap")" = "check --repo-root $SANDBOX_ROOT/elsewhere --stale-only" ] || fail "wrapper changed the notice generator's arguments: $(python_argv "$wrap")"
pass "when the notice check is aimed at a fixture tree (--repo-root), the guard says it is skipped rather than judging the wrong tree"

# =============================================================================
# Replay — the Dockerfile that actually broke the v0.1.27 publish (#3876).
# Skipped, loudly, in a clone that does not carry the history.
# =============================================================================
HOTFIX=2163b7d40011063ab27248b5efd4f5e388f0ba88
if git cat-file -e "${HOTFIX}^{commit}" 2>/dev/null && git cat-file -e "${HOTFIX}^^{commit}" 2>/dev/null; then
  replay_tree() {
    local sha="$1" dir="$SANDBOX_ROOT/$2" p
    rm -rf "$dir"
    mkdir -p "$dir/server-rust"
    git show "${sha}:server-rust/Cargo.toml" >"$dir/server-rust/Cargo.toml"
    git show "${sha}:server-rust/Dockerfile" >"$dir/server-rust/Dockerfile"
    while IFS= read -r p; do
      mkdir -p "$dir/$(dirname "$p")"
      : >"$dir/$p"
    done < <(git ls-tree -r --name-only "$sha" -- server-rust/crates server-rust/bins | grep '/Cargo.toml$')
    echo "$dir"
  }
  tree="$(replay_tree "${HOTFIX}^" replay-before-hotfix)"
  run_guard "$tree"
  expect_exit "replay: Dockerfile before the #3877 hotfix" 1 "crates/momo-workspace-actions"
  tree="$(replay_tree "${HOTFIX}" replay-after-hotfix)"
  run_guard "$tree"
  expect_green "replay: Dockerfile after the #3877 hotfix"
  pass "the Dockerfile that failed the v0.1.27 publish is red (crates/momo-workspace-actions); the hotfix commit is green"
else
  echo "[dockerfile-crates-test] skip: commit ${HOTFIX:0:9} is not in this clone — historical replay not run"
fi

echo "[dockerfile-crates-test] PASS ($CASES cases)"
