#!/usr/bin/env bash
# Isolated regression for the #1525 docs-command drift gate.
#
# A guard that is green on a healthy tree has proved nothing — `exit 0` is green
# too. Every case below either turns the guard RED for a named reason, or holds
# it GREEN somewhere turning red would be a false alarm. The false-alarm half is
# not decoration: this guard reads documents written for humans, and the way it
# dies is not by missing a defect but by crying about `<workspace-id>` until
# somebody deletes the call from local_gate.sh.
#
# Nothing here writes inside the repository. Most cases build a small synthetic
# tree rather than copying the real one, so a case says exactly one thing.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check_docs_commands.py"
SANDBOX_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/momo-docs-cmd-gate-test.XXXXXX")"
cleanup() { rm -rf "$SANDBOX_ROOT"; }
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

CASES=0
fail() { echo "[docs-cmd-test] FAIL: $*" >&2; exit 1; }
pass() { CASES=$((CASES + 1)); echo "[docs-cmd-test] ok: $*"; }

# -----------------------------------------------------------------------------
# A minimal tree with everything the guard resolves against: the tabled
# documents, a runbook directory, a Makefile, local_gate.sh (the profile list is
# read out of it, never restated), and two package.json files.
# -----------------------------------------------------------------------------
new_tree() {
  local dir="$SANDBOX_ROOT/$1"
  rm -rf "$dir"
  mkdir -p "$dir/docs/runbooks" "$dir/scripts" "$dir/clients/web" "$dir/infra" \
    "$dir/server-rust"
  printf '[workspace]\nmembers = []\n' >"$dir/server-rust/Cargo.toml"

  : >"$dir/AGENTS.md"
  : >"$dir/CODEX.md"
  : >"$dir/docs/RUN.md"
  : >"$dir/docs/RELEASING.md"
  : >"$dir/docs/NEXT_CHANNEL.md"
  : >"$dir/CONTRIBUTING.md"

  printf 'build:\n\t@true\nts-check:\n\t@true\n' >"$dir/Makefile"
  printf '{"scripts":{"lint":"true"}}\n' >"$dir/package.json"
  printf '{"scripts":{"dev":"true","gate:csp-deploy":"true"}}\n' \
    >"$dir/clients/web/package.json"
  printf 'name: x\n' >"$dir/infra/docker-compose.yml"

  # The real thing: the profile alternation has to come from this file.
  cp "$REPO_ROOT/scripts/local_gate.sh" "$dir/scripts/local_gate.sh"

  cat >"$dir/scripts/demo.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --known) echo ok ;;
esac
EOF
  chmod +x "$dir/scripts/demo.sh"

  echo "$dir"
}

# Appends a fenced shell block carrying $2 to the document $1.
add_command() {
  printf '\n```sh\n%s\n```\n' "$2" >>"$1"
}

run_guard() {
  local root="$1"; shift
  set +e
  GUARD_OUT="$(python3 "$GUARD" --root "$root" "$@" 2>&1)"
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
  pass "$what"
}

expect_green() {
  local what="$1"
  [ "$GUARD_STATUS" -eq 0 ] || fail "$what: guard went red
$GUARD_OUT"
  pass "$what"
}

# =============================================================================
# Case 1 — green on the real tree. This is the assertion that the repair in the
# same commit actually landed; without it the rest only proves the rules fire.
# =============================================================================
run_guard "$REPO_ROOT"
expect_green "green on the current tree"
case "$GUARD_OUT" in
  *"fact(s) decided"*) ;;
  *) fail "the pass line no longer reports how much it decided: $GUARD_OUT" ;;
esac

# =============================================================================
# Case 2 — #1472 itself, put back. `cargo fmt --check` against a virtual
# workspace without `--all` prints "Failed to find targets" and checks nothing;
# three workers trusted that green. This is the one rule that judges meaning
# rather than resolution, so it gets the incident's exact sentence.
# =============================================================================
tree="$(new_tree reintroduce-1472)"
add_command "$tree/AGENTS.md" 'cargo fmt --check --manifest-path server-rust/Cargo.toml'
run_guard "$tree"
expect_red "the #1472 command is caught by name" "--all"

# The repaired form must be accepted, or the rule is just noise.
tree="$(new_tree repaired-1472)"
add_command "$tree/AGENTS.md" 'cargo fmt --all --check --manifest-path server-rust/Cargo.toml'
run_guard "$tree"
expect_green "the repaired fmt command passes"

# `cargo fmt` that formats rather than checks is not this rule's business.
tree="$(new_tree fmt-not-a-check)"
add_command "$tree/AGENTS.md" 'cargo fmt --manifest-path server-rust/Cargo.toml'
run_guard "$tree"
expect_green "a formatting (non---check) cargo fmt is left alone"

# =============================================================================
# Case 3 — the executor is gone. This is the shape W-S1 (#1215) left behind in
# RUN.md: the tree was deleted, nine commands that drive it were not.
# =============================================================================
tree="$(new_tree missing-script)"
add_command "$tree/docs/RUN.md" 'scripts/macos_dev_run.sh --verify'
run_guard "$tree"
expect_red "a deleted executor is named" "scripts/macos_dev_run.sh"

# =============================================================================
# Case 4 — the executor exists but does not parse. `bash -n` is the strongest
# statement available without running a command that creates worktrees and
# pushes branches.
# =============================================================================
tree="$(new_tree broken-syntax)"
printf '#!/usr/bin/env bash\nif [ 1 -eq 1 ]; then\n' >"$tree/scripts/demo.sh"
chmod +x "$tree/scripts/demo.sh"
add_command "$tree/docs/RUN.md" 'scripts/demo.sh'
run_guard "$tree"
expect_red "a referenced script that does not parse" "구문 오류"

# ... and the same script without the +x bit.
tree="$(new_tree not-executable)"
chmod -x "$tree/scripts/demo.sh"
add_command "$tree/docs/RUN.md" 'scripts/demo.sh'
run_guard "$tree"
expect_red "a referenced script with no execute bit" "실행권한"

# =============================================================================
# Case 5 — make target, gate profile, npm script. Three different registries,
# each read out of the file that owns it.
# =============================================================================
tree="$(new_tree missing-make-target)"
add_command "$tree/docs/RUN.md" 'make no-such-target'
run_guard "$tree"
expect_red "a make target the Makefile does not define" "no-such-target"

tree="$(new_tree existing-make-target)"
add_command "$tree/docs/RUN.md" 'make build'
run_guard "$tree"
expect_green "a make target that exists"

# `--profile macos-ui` is the real one: the lane went away with the macOS tree
# and RUN.md kept telling people to run it.
tree="$(new_tree missing-gate-profile)"
add_command "$tree/docs/RUN.md" 'scripts/local_gate.sh --profile macos-ui'
run_guard "$tree"
expect_red "a local_gate profile that no longer exists" "macos-ui"

tree="$(new_tree existing-gate-profile)"
add_command "$tree/docs/RUN.md" 'scripts/local_gate.sh --profile docs'
run_guard "$tree"
expect_green "a local_gate profile that exists"

tree="$(new_tree missing-npm-script)"
add_command "$tree/docs/runbooks/deploy.md" 'npm --prefix clients/web run no-such-script'
run_guard "$tree"
expect_red "an npm script package.json does not define" "no-such-script"

# The runbook defect this found: a clients/web script invoked from the root,
# where npm answers "Missing script".
tree="$(new_tree npm-wrong-prefix)"
add_command "$tree/docs/runbooks/deploy.md" 'npm run gate:csp-deploy'
run_guard "$tree"
expect_red "a clients/web script run from the repo root" "gate:csp-deploy"

tree="$(new_tree npm-right-prefix)"
add_command "$tree/docs/runbooks/deploy.md" 'npm --prefix clients/web run gate:csp-deploy'
run_guard "$tree"
expect_green "the same script with the prefix that makes it resolve"

# =============================================================================
# Case 6 — a flag the script has never heard of. #1472 was not a missing file;
# it was a flag combination that meant nothing to the tool.
# =============================================================================
tree="$(new_tree unknown-flag)"
add_command "$tree/docs/RUN.md" 'scripts/demo.sh --invented'
run_guard "$tree"
expect_red "a long flag the script does not accept" "--invented"

tree="$(new_tree known-flag)"
add_command "$tree/docs/RUN.md" 'scripts/demo.sh --known'
run_guard "$tree"
expect_green "a long flag the script does accept"

# A dispatcher forwards "$@" to somewhere else, so its subcommand's flags are
# not its own. Judging them would red-flag every `scripts/momo host add …` line.
tree="$(new_tree dispatcher-subcommand-flag)"
add_command "$tree/docs/RUN.md" 'scripts/demo.sh host add --invented'
run_guard "$tree"
expect_green "flags behind a subcommand are not attributed to the dispatcher"

# =============================================================================
# Case 7 — paths carried by flags: compose overlays and build trees.
# =============================================================================
tree="$(new_tree missing-compose-file)"
add_command "$tree/docs/runbooks/deploy.md" 'docker compose -f infra/docker-compose.gone.yml up -d'
run_guard "$tree"
expect_red "a compose overlay that is not in the tree" "infra/docker-compose.gone.yml"

tree="$(new_tree present-compose-file)"
add_command "$tree/docs/runbooks/deploy.md" 'docker compose -f infra/docker-compose.yml up -d'
run_guard "$tree"
expect_green "a compose overlay that is in the tree"

tree="$(new_tree deleted-package-path)"
add_command "$tree/docs/RUN.md" 'swift build --package-path clients/macOS'
run_guard "$tree"
expect_red "a build aimed at a deleted tree" "clients/macOS"

# =============================================================================
# Case 8 — the false-alarm half. Every one of these was extracted from the real
# documents, and each would have made the guard unusable.
# =============================================================================
tree="$(new_tree no-false-alarms)"
add_command "$tree/docs/RUN.md" 'scripts/demo.sh <issue-number>'
add_command "$tree/docs/RUN.md" 'make ${TARGET}'
add_command "$tree/docs/RUN.md" 'npm --prefix <tree> run <script>'
add_command "$tree/docs/RUN.md" 'docker compose -f infra/*.yml config'
add_command "$tree/docs/RUN.md" 'scripts/local_gate.sh --profile <docs|web|all>'
printf '\n`scripts/transcription/README.md`를 따른다.\n' >>"$tree/docs/RUN.md"
printf '\n```text\nmacOS dev launch: swift build --package-path clients/macOS\n```\n' \
  >>"$tree/docs/RUN.md"
run_guard "$tree"
expect_green "placeholders, globs, prose file references and non-shell blocks"

# =============================================================================
# Case 9 — the escape hatch, and the fact that it is scoped to its line.
# =============================================================================
tree="$(new_tree ignore-marker)"
printf '\n- 이 절차는 폐지됐다: `npm run no-such-script`. <!-- docs-cmd-ignore: 폐지된 절차를 이름으로 부르는 문장 -->\n' \
  >>"$tree/docs/RUN.md"
run_guard "$tree"
expect_green "a marked line is exempt"

tree="$(new_tree ignore-marker-scope)"
printf '\n- 폐지: `npm run gone-a`. <!-- docs-cmd-ignore: 이유 -->\n- 살아있어야 함: `npm run gone-b`.\n' \
  >>"$tree/docs/RUN.md"
run_guard "$tree"
expect_red "the marker covers only its own line" "gone-b"
case "$GUARD_OUT" in
  *gone-a*) fail "the marked line was reported anyway: $GUARD_OUT" ;;
esac

# A marker with no reason is not a marker.
tree="$(new_tree ignore-marker-needs-reason)"
printf '\n- `npm run gone-c`. <!-- docs-cmd-ignore: -->\n' >>"$tree/docs/RUN.md"
run_guard "$tree"
expect_red "a reasonless marker does not exempt anything" "gone-c"

# =============================================================================
# Case 10 — coverage. A new runbook is gated the moment it exists, and a tabled
# document that disappears fails loudly instead of quietly dropping coverage.
# =============================================================================
tree="$(new_tree new-runbook-is-gated)"
printf '# 새 런북\n' >"$tree/docs/runbooks/brand-new.md"
add_command "$tree/docs/runbooks/brand-new.md" 'make no-such-target'
run_guard "$tree"
expect_red "a newly added runbook is gated without being listed" "brand-new.md"

tree="$(new_tree tabled-doc-vanished)"
rm "$tree/CODEX.md"
run_guard "$tree"
expect_red "a tabled document that no longer exists" "CODEX.md"

echo "[docs-cmd-test] PASS: $CASES case(s)"
