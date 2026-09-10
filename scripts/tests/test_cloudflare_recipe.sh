#!/usr/bin/env bash
# SH-11d / #2386 — Cloudflare T3 edge recipe: ingress loopback-only, catch-all
# 404, no quick-tunnel, no token literals, no compute-deploy claims, live
# script paths. Sabotage of each §2 contract must go RED.
set -euo pipefail

CASES=0

fail() {
  printf '[test-cloudflare-recipe] FAIL %s\n' "$*" >&2
  exit 1
}

pass() {
  CASES=$((CASES + 1))
  printf '[test-cloudflare-recipe] PASS %s\n' "$*"
}

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

RECIPE="$ROOT/infra/cloudflare"
README="$RECIPE/README.md"
CONFIG="$RECIPE/cloudflared.config.example.yml"
DNS="$RECIPE/dns.example.md"
CADDY_LOCAL="$ROOT/infra/rust/Caddyfile.local"
LEAD='「Cloudflare에 oort를 배포」는 없다. api·PG·Centrifugo는 Workers/Pages/Containers에 올리지 않는다'

command -v python3 >/dev/null 2>&1 || fail "python3 없음"
[ -d "$RECIPE" ] || fail "infra/cloudflare/ missing"
[ -f "$README" ] || fail "infra/cloudflare/README.md missing"
[ -f "$CONFIG" ] || fail "infra/cloudflare/cloudflared.config.example.yml missing"
[ -f "$DNS" ] || fail "infra/cloudflare/dns.example.md missing"
[ -f "$CADDY_LOCAL" ] || fail "infra/rust/Caddyfile.local missing"

# Loopback Caddy already has the exclusive 403. Missing handle = edge-contract
# defect: report to planner, do not patch Caddy in this recipe.
python3 - "$CADDY_LOCAL" <<'PY' || fail "Caddyfile.local missing /v1/centrifugo/* 403 — report to planner (edge contract); do not patch Caddy here"
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text(encoding="utf-8")
if not re.search(r"handle /v1/centrifugo/\* \{\n\s*respond 403\n\s*\}", text):
    sys.exit(1)
PY
pass "Caddyfile.local cites exclusive /v1/centrifugo/* 403 (do not patch)"

# cloudflared/wrangler are not contract probes. Print a visible skip/info so
# a reader does not mistake the absence for a silent optional-tool skip.
if command -v cloudflared >/dev/null 2>&1; then
  printf '[test-cloudflare-recipe] INFO no optional tool step (cloudflared/wrangler not a contract probe); cloudflared --version: %s\n' \
    "$(cloudflared --version 2>&1 | head -1)"
else
  printf '[test-cloudflare-recipe] SKIP cloudflared not on PATH — no optional tool step (static recipe does not require cloudflared or wrangler)\n'
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/oort-cloudflare-recipe.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

CHECKER="$TMP/check_recipe.py"
cat >"$CHECKER" <<'PY'
"""Static contract for infra/cloudflare/. Exit 0 = GREEN, 1 = RED."""
from __future__ import annotations

import re
import sys
from pathlib import Path

LOOPBACK_PREFIXES = ("http://127.0.0.1:", "http://localhost:")
STATUS_404 = "http_status:404"
# Any flags between `cloudflared tunnel` and `--url` / `--url=` (E2E-A form).
QUICK_TUNNEL_RE = re.compile(r"cloudflared\s+tunnel\b[^\n]*--url(?:\b|=)")
TOKEN_RE = re.compile(r"CLOUDFLARE_API_TOKEN=([A-Za-z0-9+/=_-]{40,})")
SCRIPT_RE = re.compile(r"(?<![A-Za-z0-9_./-])(scripts/[A-Za-z0-9_./-]+)")
NON_EXEC_EXT = (".md", ".json", ".yaml", ".yml", ".sql", ".toml", ".txt", ".example")
NEGATION = re.compile(
    r"(not |never |do not |don't |않|금지|채택하지|올리지 않|쓰지 않|unused|is not)",
    re.I,
)
COMPUTE_HIT = re.compile(
    r"(workers?|pages|containers?).{0,80}(api|postgres|\bpg\b|centrifugo)"
    r"|(api|postgres|\bpg\b|centrifugo).{0,80}(workers?|pages|containers?)",
    re.I,
)
DEPLOY_HIT = re.compile(r"(deploy|배포|올린다|올려)", re.I)
PUBLIC_ORIGIN_FLAG = "--public-origin"
SKIP_USER_ERROR = re.compile(r"(user error|사용자 오류)", re.I)

COMPOSE_NAMES = (
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
)


def fail(msg: str) -> int:
    sys.stderr.write("RED %s\n" % msg)
    return 1


def ingress_services(path: Path) -> list[str]:
    services: list[str] = []
    in_ingress = False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        raw = raw_line.split("#", 1)[0].rstrip()
        if not raw.strip():
            continue
        if re.match(r"^ingress:\s*$", raw):
            in_ingress = True
            continue
        if in_ingress:
            if re.match(r"^[A-Za-z0-9_.-]+:", raw) and not raw[:1].isspace() and not raw.lstrip().startswith("-"):
                in_ingress = False
                continue
            m = re.search(r"\bservice:\s*(\S+)", raw)
            if m:
                services.append(m.group(1).strip().strip("\"'"))
    return services


def check_config(path: Path) -> str | None:
    services = ingress_services(path)
    if not services:
        return "%s: no ingress service:" % path
    last = services[-1]
    if last != STATUS_404:
        return "%s: last ingress service is %s (want %s)" % (path, last, STATUS_404)
    for svc in services[:-1]:
        if not svc.startswith(LOOPBACK_PREFIXES):
            return "%s: ingress service not loopback: %s" % (path, svc)
        if "0.0.0.0" in svc:
            return "%s: ingress service binds 0.0.0.0: %s" % (path, svc)
    return None


def markdown_section(text: str, heading: str) -> str | None:
    """Return the `## heading…` block up to the next `## ` heading."""
    lines = text.splitlines(True)
    start = None
    for i, line in enumerate(lines):
        if line.startswith(heading):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    return "".join(lines[start:end])


def cited_scripts(text: str) -> list[str]:
    seen: list[str] = []
    for m in SCRIPT_RE.finditer(text):
        rel = m.group(1).rstrip(".,;:)")
        if rel.endswith("/"):
            continue
        if any(rel.endswith(ext) for ext in NON_EXEC_EXT):
            continue
        if rel not in seen:
            seen.append(rel)
    return seen


def check_readme(path: Path, root: Path) -> str | None:
    text = path.read_text(encoding="utf-8")
    paras = [p.strip() for p in text.split("\n\n") if p.strip() and not p.strip().startswith("#")]
    lead = paras[0] if paras else ""
    want = "「Cloudflare에 oort를 배포」는 없다."
    if want not in lead:
        return "%s: first paragraph is not the 'what this is not' sentence" % path
    mode_b = markdown_section(text, "## Mode B")
    if mode_b is None:
        return "%s: missing ## Mode B (Tunnel mode) section" % path
    if PUBLIC_ORIGIN_FLAG not in mode_b:
        return "%s: Mode B (Tunnel mode) missing %s" % (path, PUBLIC_ORIGIN_FLAG)
    approval = markdown_section(text, "## Human approval points")
    if approval is None:
        return "%s: missing ## Human approval points section" % path
    approval_need = (
        (
            "login/OAuth or token",
            lambda s: bool(
                re.search(r"login", s, re.I)
                and (re.search(r"OAuth", s) or re.search(r"API token", s, re.I))
            ),
        ),
        ("NS delegation", lambda s: bool(re.search(r"nameserver", s, re.I))),
        (
            "host tunnel token",
            lambda s: bool(
                re.search(r"tunnel token", s, re.I) and re.search(r"\bhost\b", s, re.I)
            ),
        ),
        ("cleanup", lambda s: bool(re.search(r"cleanup", s, re.I))),
    )
    missing = [name for name, pred in approval_need if not pred(approval)]
    if missing:
        return "%s: approval section missing %s" % (path, ", ".join(missing))
    if not SKIP_USER_ERROR.search(text):
        return "%s: does not say doctor skip is a user error" % path
    for m in COMPUTE_HIT.finditer(text):
        # Window around the match: negation must be in the same sentence.
        start = max(0, m.start() - 80)
        end = min(len(text), m.end() + 80)
        window = text[start:end]
        if DEPLOY_HIT.search(window) and not NEGATION.search(window):
            return "%s: affirmative Workers/Containers compute-deploy claim: %s" % (
                path,
                window.replace("\n", " ")[:160],
            )
    for rel in cited_scripts(text):
        if not (root / rel).exists():
            return "%s: cited %s does not exist" % (path, rel)
    return None


def check_tree(recipe: Path, repo: Path) -> str | None:
    if not recipe.is_dir():
        return "recipe dir missing: %s" % recipe
    for name in COMPOSE_NAMES:
        if (recipe / name).exists():
            return "compose file invented in recipe: %s" % (recipe / name)
    for path in sorted(recipe.rglob("*")):
        if not path.is_file():
            continue
        blob = path.read_text(encoding="utf-8", errors="replace")
        if QUICK_TUNNEL_RE.search(blob):
            return "%s: quick-tunnel 'cloudflared tunnel … --url' is forbidden in the recipe" % path
        if TOKEN_RE.search(blob):
            return "%s: CLOUDFLARE_API_TOKEN= literal (≥40 base64) is forbidden" % path
        if path.suffix in {".yml", ".yaml"} and "ingress:" in blob:
            err = check_config(path)
            if err:
                return err
    readme = recipe / "README.md"
    if not readme.is_file():
        return "README.md missing in %s" % recipe
    return check_readme(readme, repo)


def main() -> int:
    if len(sys.argv) != 3:
        return fail("usage: check_recipe.py RECIPE_DIR REPO_ROOT")
    samples = (
        "cloudflared tunnel --url http://127.0.0.1:8088",
        "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8088",
        "cloudflared tunnel --url=http://127.0.0.1:8088",
    )
    for sample in samples:
        if not QUICK_TUNNEL_RE.search(sample):
            return fail("QUICK_TUNNEL_RE missed %r" % sample)
    if QUICK_TUNNEL_RE.search("cloudflared tunnel create oort"):
        return fail("QUICK_TUNNEL_RE false-positive on tunnel create")
    err = check_tree(Path(sys.argv[1]), Path(sys.argv[2]))
    if err:
        return fail(err)
    sys.stdout.write("GREEN %s\n" % sys.argv[1])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY

run_check() {
  local dir="$1"
  python3 "$CHECKER" "$dir" "$ROOT"
}

# ---------------------------------------------------------------------------
# Happy path GREEN
# ---------------------------------------------------------------------------
set +e
happy_out="$TMP/happy.out"
run_check "$RECIPE" >"$happy_out" 2>"$happy_out.err"
happy_ec=$?
set -e
[ "$happy_ec" = "0" ] || {
  cat "$happy_out" "$happy_out.err" >&2
  fail "happy-path recipe unexpectedly RED"
}
grep -Fq "$LEAD" "$README" || fail "README first paragraph missing the contracted 'what this is not' sentence"
pass "happy-path recipe GREEN"

# ---------------------------------------------------------------------------
# Sabotage ① ingress → public IP:8088 → RED
# ---------------------------------------------------------------------------
sab1="$TMP/sab1"
cp -R "$RECIPE" "$sab1"
python3 - "$sab1/cloudflared.config.example.yml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
text = text.replace("http://127.0.0.1:8088", "http://203.0.113.10:8088")
p.write_text(text, encoding="utf-8")
PY
set +e
run_check "$sab1" >"$TMP/sab1.out" 2>"$TMP/sab1.err"
sab1_ec=$?
set -e
[ "$sab1_ec" != "0" ] || fail "sabotage ① public-IP ingress still GREEN — checker is not load-bearing"
grep -Eiq 'loopback|203\.0\.113\.10|not loopback' "$TMP/sab1.err" \
  || fail "sabotage ① stderr did not name the public-IP ingress"
pass "sabotage ① ingress http://203.0.113.10:8088 → RED"

# ---------------------------------------------------------------------------
# Sabotage ② drop catch-all 404 → RED
# ---------------------------------------------------------------------------
sab2="$TMP/sab2"
cp -R "$RECIPE" "$sab2"
python3 - "$sab2/cloudflared.config.example.yml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = p.read_text(encoding="utf-8").splitlines(True)
out = [ln for ln in lines if "http_status:404" not in ln]
p.write_text("".join(out), encoding="utf-8")
PY
set +e
run_check "$sab2" >"$TMP/sab2.out" 2>"$TMP/sab2.err"
sab2_ec=$?
set -e
[ "$sab2_ec" != "0" ] || fail "sabotage ② missing catch-all 404 still GREEN — checker is not load-bearing"
grep -Eiq '404|last ingress' "$TMP/sab2.err" \
  || fail "sabotage ② stderr did not name the missing 404"
pass "sabotage ② catch-all 404 removed → RED"

# ---------------------------------------------------------------------------
# Sabotage ③ add quick-tunnel command → RED
# ---------------------------------------------------------------------------
sab3="$TMP/sab3"
cp -R "$RECIPE" "$sab3"
printf '\ncloudflared tunnel --url http://127.0.0.1:8088\n' >>"$sab3/README.md"
set +e
run_check "$sab3" >"$TMP/sab3.out" 2>"$TMP/sab3.err"
sab3_ec=$?
set -e
[ "$sab3_ec" != "0" ] || fail "sabotage ③ quick-tunnel still GREEN — checker is not load-bearing"
grep -Eiq 'tunnel --url|quick-tunnel|--url' "$TMP/sab3.err" \
  || fail "sabotage ③ stderr did not name tunnel --url"
pass "sabotage ③ cloudflared tunnel --url added → RED"

# R2: live E2E-A form (flags between tunnel and --url) must also RED.
sab3b="$TMP/sab3b"
cp -R "$RECIPE" "$sab3b"
printf '\ncloudflared tunnel --no-autoupdate --url http://127.0.0.1:8088\n' >>"$sab3b/README.md"
set +e
run_check "$sab3b" >"$TMP/sab3b.out" 2>"$TMP/sab3b.err"
sab3b_ec=$?
set -e
[ "$sab3b_ec" != "0" ] || fail "sabotage ③b --no-autoupdate --url still GREEN — checker is not load-bearing"
grep -Eiq 'tunnel --url|quick-tunnel|--url' "$TMP/sab3b.err" \
  || fail "sabotage ③b stderr did not name --url"
pass "sabotage ③b cloudflared tunnel --no-autoupdate --url added → RED"

# ---------------------------------------------------------------------------
# Sabotage ④ Tunnel mode (Mode B only) omits --public-origin → RED
# Mode A / tables may still mention the flag; the Tunnel-mode section must
# require it on its own.
# ---------------------------------------------------------------------------
sab4="$TMP/sab4"
cp -R "$RECIPE" "$sab4"
python3 - "$sab4/README.md" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
lines = text.splitlines(True)
start = None
for i, line in enumerate(lines):
    if line.startswith("## Mode B"):
        start = i
        break
if start is None:
    raise SystemExit("Mode B heading missing in fixture README")
end = len(lines)
for i in range(start + 1, len(lines)):
    if lines[i].startswith("## "):
        end = i
        break
block = "".join(lines[start:end]).replace("--public-origin", "--no-such-flag")
p.write_text("".join(lines[:start]) + block + "".join(lines[end:]), encoding="utf-8")
PY
set +e
run_check "$sab4" >"$TMP/sab4.out" 2>"$TMP/sab4.err"
sab4_ec=$?
set -e
[ "$sab4_ec" != "0" ] || fail "sabotage ④ Mode B --public-origin drop still GREEN — checker is not load-bearing"
grep -Eiq -- '--public-origin|Mode B' "$TMP/sab4.err" \
  || fail "sabotage ④ stderr did not name Mode B --public-origin"
pass "sabotage ④ Mode B --public-origin omitted (Mode A kept) → RED"

# ---------------------------------------------------------------------------
# Sabotage ⑤ delete the human-approval section → RED
# ---------------------------------------------------------------------------
sab5="$TMP/sab5"
cp -R "$RECIPE" "$sab5"
python3 - "$sab5/README.md" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
lines = text.splitlines(True)
start = None
for i, line in enumerate(lines):
    if line.startswith("## Human approval points"):
        start = i
        break
if start is None:
    raise SystemExit("approval heading missing in fixture README")
end = len(lines)
for i in range(start + 1, len(lines)):
    if lines[i].startswith("## "):
        end = i
        break
p.write_text("".join(lines[:start]) + "".join(lines[end:]), encoding="utf-8")
PY
set +e
run_check "$sab5" >"$TMP/sab5.out" 2>"$TMP/sab5.err"
sab5_ec=$?
set -e
[ "$sab5_ec" != "0" ] || fail "sabotage ⑤ approval section deleted still GREEN — checker is not load-bearing"
grep -Eiq 'approval' "$TMP/sab5.err" \
  || fail "sabotage ⑤ stderr did not name the approval section"
pass "sabotage ⑤ Human approval points section deleted → RED"

# Extra: token literal and compose invention stay RED
sab_tok="$TMP/sab-tok"
cp -R "$RECIPE" "$sab_tok"
{
  printf 'CLOUDFLARE_API_TOKEN='
  printf '%s' 'testtokenforcloudflarerecipegate1234567890' | openssl base64 | tr -d '\n'
  printf '\n'
} >>"$sab_tok/dns.example.md"
set +e
run_check "$sab_tok" >"$TMP/sab-tok.out" 2>"$TMP/sab-tok.err"
sab_tok_ec=$?
set -e
[ "$sab_tok_ec" != "0" ] || fail "token literal still GREEN — checker is not load-bearing"
pass "extra: CLOUDFLARE_API_TOKEN= literal → RED"

sab_comp="$TMP/sab-compose"
cp -R "$RECIPE" "$sab_comp"
printf 'services: {}\n' >"$sab_comp/docker-compose.yml"
set +e
run_check "$sab_comp" >"$TMP/sab-comp.out" 2>"$TMP/sab-comp.err"
sab_comp_ec=$?
set -e
[ "$sab_comp_ec" != "0" ] || fail "invented compose file still GREEN — checker is not load-bearing"
pass "extra: compose file in recipe dir → RED"

pass "all Cloudflare T3 recipe contracts + sabotages"
printf '[test-cloudflare-recipe] PASS case count=%s\n' "$CASES"
