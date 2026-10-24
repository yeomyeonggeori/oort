#!/usr/bin/env bash
# SEC-07 (#4245): the removed-tree lint must go red on a script that launches the
# deleted Swift server and stay green on live shapes. Isolated temp tree only.
set -euo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
LINT="$SCRIPT_DIR/../check_removed_tree_refs.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/oort-removed-tree-refs.XXXXXX")"
trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/scripts/lib" "$T/scripts/tests"

fail() { echo "[removed-tree-refs-test] FAIL: $*" >&2; exit 1; }
expect_green() { "$LINT" "$T" >/dev/null 2>&1 || fail "expected green: $1"; echo "[removed-tree-refs-test] ok: $1"; }
expect_red() { if "$LINT" "$T" >/dev/null 2>&1; then fail "expected red: $1"; fi; echo "[removed-tree-refs-test] ok (red): $1"; }

printf '#!/usr/bin/env bash\ncargo test -p momo-server\n# swift run --package-path server MomoServer (historic comment)\npsql server/Migrations/001.sql\n' >"$T/scripts/verify_ok.sh"
printf 'quoted fixture: swift build --package-path clients/macOS\n' >"$T/scripts/tests/fixture.sh"
expect_green "live shapes: cargo, comment, server/Migrations path, tests/ fixture"

printf '#!/usr/bin/env bash\nswift run --package-path server MomoServer &\n' >"$T/scripts/verify_dead.sh"
expect_red "swift run of the deleted server"
rm "$T/scripts/verify_dead.sh"

printf '#!/usr/bin/env bash\nswift build --package-path workers/AgentWorker\n' >"$T/scripts/lib/dead.sh"
expect_red "swift build in lib/"
rm "$T/scripts/lib/dead.sh"

printf '#!/usr/bin/env bash\nrun --package-path clients/macOS thing\n' >"$T/scripts/momo"
expect_red "package-path into a deleted client tree (scripts/momo)"
rm "$T/scripts/momo"
expect_green "back to clean after removal"
echo "[removed-tree-refs-test] PASS"
