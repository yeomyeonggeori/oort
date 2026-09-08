#!/usr/bin/env bash
# SH-9 / #2231 — docs/external-agent-provider + SELF_HOST §5 local-provider
# citations must resolve. A green tree that never names a dead path has proved
# nothing if the extractor is asleep, so sabotage (re-insert a deleted script
# path) must turn this RED.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

fail() { printf '[test-external-agent-provider-docs] FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf '[test-external-agent-provider-docs] PASS %s\n' "$*"; }

DOCS=(docs/external-agent-provider/*.md)
[ -e "${DOCS[0]}" ] || fail "docs/external-agent-provider/*.md missing"

SELF_HOST_EN="docs/SELF_HOST.md"
SELF_HOST_KO="docs/SELF_HOST.ko.md"
[ -f "$SELF_HOST_EN" ] || fail "$SELF_HOST_EN missing"
[ -f "$SELF_HOST_KO" ] || fail "$SELF_HOST_KO missing"

extract_section() {
  local file="$1" heading="$2"
  python3 - "$file" "$heading" <<'PY'
import sys
from pathlib import Path
path, heading = sys.argv[1], sys.argv[2]
lines = Path(path).read_text(encoding="utf-8").splitlines(True)
start = None
for i, line in enumerate(lines):
    if line.rstrip() == heading:
        start = i
        break
if start is None:
    sys.stderr.write(f"heading not found: {heading} in {path}\n")
    sys.exit(2)
end = len(lines)
for i in range(start + 1, len(lines)):
    if lines[i].startswith("### ") and lines[i].rstrip() != heading:
        end = i
        break
sys.stdout.write("".join(lines[start:end]))
PY
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/oort-eap-docs.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

collect="$TMP/corpus.txt"
: >"$collect"
cat docs/external-agent-provider/*.md >>"$collect"
extract_section "$SELF_HOST_EN" "### Local provider (same machine)" >>"$collect"
extract_section "$SELF_HOST_KO" "### 로컬 provider (같은 머신)" >>"$collect"

# Swift runtime names (LS-1 deleted). Compose service names api/relay/agent-worker
# are allowed; PascalCase leftovers are not.
if grep -nE 'MomoServer|AgentWorker|OutboxRelay' "$collect"; then
  fail "Swift runtime name still cited (MomoServer|AgentWorker|OutboxRelay)"
fi
pass "0 Swift runtime names (MomoServer|AgentWorker|OutboxRelay)"

if grep -nE '28180|28100' "$collect"; then
  fail "fixed ports 28180/28100 still cited"
fi
pass "0 fixed ports 28180/28100"

# Bare scripts/… paths (not directories). Placeholders like <provider-port> are
# not part of the path token.
cited="$(
  python3 - "$collect" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
# Match scripts/foo, scripts/foo.sh, scripts/foo/bar.sh — stop at whitespace,
# quotes, backticks, closing parens, or markdown emphasis.
pat = re.compile(r'(?<![A-Za-z0-9_./-])(scripts/[A-Za-z0-9_./-]+)')
seen = []
for m in pat.finditer(text):
    rel = m.group(1).rstrip(".,;:)")
    if rel.endswith("/"):
        continue
    if rel not in seen:
        seen.append(rel)
for rel in seen:
    print(rel)
PY
)"

[ -n "$cited" ] || fail "extractor found 0 scripts/ paths — the corpus is empty or the regex is asleep"

missing=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if [ ! -e "$ROOT/$rel" ]; then
    printf '[test-external-agent-provider-docs] dead citation: %s\n' "$rel" >&2
    missing=1
  fi
done <<<"$cited"
[ "$missing" -eq 0 ] || fail "one or more cited scripts/ paths do not exist"
pass "cited scripts/ paths exist ($(printf '%s\n' "$cited" | grep -c .))"

# Optional isolated sabotage: copy corpus, inject a deleted path, expect RED.
if [ "${EAP_DOCS_PROVE_RED:-0}" = "1" ]; then
  fake="$TMP/sabotage.md"
  cp "$collect" "$fake"
  printf '\n`scripts/verify_external_agent_provider.sh`\n' >>"$fake"
  if [ -e "$ROOT/scripts/verify_external_agent_provider.sh" ]; then
    fail "sabotage target scripts/verify_external_agent_provider.sh unexpectedly exists"
  fi
  if python3 - "$fake" "$ROOT" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
root = Path(sys.argv[2])
pat = re.compile(r'(?<![A-Za-z0-9_./-])(scripts/[A-Za-z0-9_./-]+)')
dead = []
for m in pat.finditer(text):
    rel = m.group(1).rstrip(".,;:)")
    if rel.endswith("/"):
        continue
    if not (root / rel).exists():
        dead.append(rel)
if not dead:
    sys.exit(1)
print("dead:" + ",".join(sorted(set(dead))))
sys.exit(0)
PY
  then
    pass "sabotage isolated corpus: dead citation detected"
    exit 0
  fi
  fail "sabotage isolated corpus stayed green"
fi
